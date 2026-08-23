import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
  Modal,
  TextInput,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Pressable,
  FlatList,
  Animated,
  Easing,
  PanResponder,
  ScrollView,
  type TextProps,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { PnlShareExportFrame } from '../../src/components/PnlShareExportFrame';
import { sharePnlPng } from '../../src/lib/sharePnlImage';
import ViewShot from 'react-native-view-shot';
import MaskedView from '@react-native-masked-view/masked-view';
import { fetchAssetDetail, fetchAssets, fetchCryptoAssets, fetchCryptoMetadata, fetchStockFundamentals, fetchAssetDescription, Asset, CryptoMetadata, StockFundamentals, reportTrade } from '../../src/lib/api';
import { isHiddenLowLiquidityGoldSpotAsset } from '../../src/lib/hiddenMarkets';
import { formatDisplaySymbol } from '../../src/lib/displaySymbols';
import { colors, getLeverageColor, getPriceChangeColor } from '../../src/theme/colors';
import { useAppStore } from '../../src/store/appStore';
import { useClaimBannerTopInset, useTopStripContentHeight } from '../../src/components/ClaimTradingCreditBanner';
import { loadFavorites, toggleFavorite } from '../../src/lib/favorites';
import { fetchAssetOnboardingStatus, completeAssetOnboarding, isAssetOnboardingCachedComplete, resetAssetOnboardingCache } from '../../src/lib/onboarding';
import { pushRouteOnce } from '../../src/lib/pushRouteOnce';
import { AssetChart } from '../../src/components/AssetChart';
import { AssetLogo } from '../../src/components/AssetLogo';
import { GeminiAnalysisPanel } from '../../src/components/GeminiAnalysisPanel';
import { PortfolioTabs } from '../../src/components/PortfolioTabs';
import { QuickTradeCard } from '../../src/components/QuickTradeCard';
import { TradingBookSwitcher } from '../../src/components/TradingBookSwitcher';
import { FloatingTradeAlert } from '../../src/components/FloatingTradeAlert';
import { QuickTradeDrawerGlow } from '../../src/components/QuickTradeDrawerGlow';
import { LoadingIndicator } from '../../src/components/LoadingSpinner';
import { useActiveEthereumWallet } from '../../src/hooks/useActiveEthereumWallet';
import { useActiveTradingBook } from '../../src/hooks/useActiveTradingBook';
import { overlaySignerAgentActive, useSignerTradingSetup } from '../../src/hooks/useSignerTradingSetup';
import { useSeamlessSetup } from '../../src/providers/SeamlessSetupProvider';
import { useHyperliquidAccountStream } from '../../src/lib/useHyperliquidAccountStream';
import { useLiveAssetCtxs, useLivePrices, usePricesRef } from '../../src/providers/WebSocketProvider';
import { computeUnifiedSpotTransferableUsd, estimateRestingOrdersInitMarginByDex, estimateRestingOrdersInitMarginUsd, estimateSpotOpenOrdersUsdcHoldUsd, getHyperliquidTradingState, getOpenOrders, getUserFills, getUserFunding, getActiveAssetData, getSpotAssetData, getSpotClearinghouseState, getSpotSymbolMap, cancelOpenOrder, mergeRestAndStreamOpenOrders, modifyOpenOrder, marketClosePosition, marketCloseSpotPosition, ensureAgentKey, isBuilderFeeApproved, isPooledAccountMode, isRateLimitError, placeReduceOnlyTpslTrigger, setupTradingAccount, rotateAgentKey, prewarmOrderCaches, isTradingSetupComplete, markTradingSetupComplete, type Eip1193Provider } from '../../src/lib/hyperliquid';
import { showToast } from '../../src/lib/toast';
import { humanizeHyperliquidError } from '../../src/lib/hyperliquidErrors';
import { Analytics } from '../../src/lib/analytics';
import { useTranslation } from 'react-i18next';
import { useDisplayCurrency } from '../../src/providers/CurrencyProvider';
import { useAuth } from '../../src/providers/AuthContext';
import { pickPrice } from '../../src/lib/priceKeys';
import {
  expandAssetSearchRows,
  type AssetSearchRow,
} from '../../src/lib/searchSpotRows';
import { demoAllowsSpot } from '../../src/lib/demo';
import { openHttpsUrl } from '../../src/lib/openHttpsUrl';

function fmtDollar(v: number | null | undefined): string {
  if (v == null) return '--';
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a >= 1e12) return `${sign}$${(a / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  return `${sign}$${a.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

/** FMP reports won-denominated profile/statements for these .KS names.
 * SKHY is a US Nasdaq ADS (not KRW) — do not include it here. */
const KRW_LISTED_STOCK_SYMBOLS = new Set(['SMSN']);

/** Opens X/Twitter search for a cashtag (e.g. $BTC). Uses display symbol from asset detail. */
function buildXCashtagSearchUrl(displaySymbol: string): string {
  const tag = displaySymbol.trim().replace(/^\$+/, '').toUpperCase();
  if (!tag) return 'https://x.com/search';
  return `https://x.com/search?q=${encodeURIComponent(`$${tag}`)}`;
}
// Keep GOLD wiring intact, but hide it from demo until the testnet xyz:GOLD book improves.
const DEMO_PERP_BASE_WHITELIST = new Set(['BTC', 'ETH']);
const HEADER_ASSET_CTX_FRESH_MS = 10_000;
const ASSET_PRICE_SAMPLE_MS = 500;
const SEARCH_PRICE_SAMPLE_MS = 1_000;
const getDemoBaseSymbol = (asset: Pick<Asset, 'symbol' | 'coin'>) => {
  const sym = (asset.symbol || asset.coin || '').toUpperCase();
  return sym.includes(':') ? sym.split(':').pop()! : sym;
};


function fmtKrw(v: number | null | undefined, fractionDigits = 0): string {
  if (v == null) return '--';
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a >= 1e12) return `${sign}₩${(a / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${sign}₩${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}₩${(a / 1e6).toFixed(2)}M`;
  return `${sign}₩${a.toLocaleString('en-US', { maximumFractionDigits: fractionDigits })}`;
}

/**
 * Format next earnings for the Info grid. API returns `YYYY-MM-DD` or the
 * field is omitted when unknown — show a TBA label so users still see the row.
 * Dates are compared on the local calendar to avoid UTC midnight off-by-one.
 */
function formatNextEarningsInfoValue(
  raw: string | null | undefined,
  locale: string,
  tbaLabel: string,
): string {
  const s = (raw || '').trim();
  if (!s) return tbaLabel;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  let d: Date;
  if (iso) {
    const y = Number(iso[1]);
    const mo = Number(iso[2]) - 1;
    const day = Number(iso[3]);
    if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(day)) return tbaLabel;
    d = new Date(y, mo, day);
  } else {
    d = new Date(s);
    if (Number.isNaN(d.getTime())) return tbaLabel;
    d.setHours(0, 0, 0, 0);
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);
  if (d < today) return tbaLabel;
  return d.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Format a stock fundamental numeric field; show TBA when Finnhub/DB has no value. */
function formatStockFundamentalValue(
  value: number | null | undefined,
  formatValue: (n: number) => string,
  tbaLabel: string,
): string {
  if (value == null || !Number.isFinite(value)) return tbaLabel;
  return formatValue(value);
}

/** Live mcap from manual shares × HL price; falls back to stored Finnhub mkt_cap. */
function computeLiveStockMktCap(
  outstandingShares: number | null | undefined,
  livePrice: number | null | undefined,
  fallbackMktCap: number | null | undefined,
): number | null {
  const shares = outstandingShares != null ? Number(outstandingShares) : NaN;
  const px = livePrice != null ? Number(livePrice) : NaN;
  if (Number.isFinite(shares) && shares > 0 && Number.isFinite(px) && px > 0) {
    return shares * px;
  }
  if (fallbackMktCap != null && Number.isFinite(fallbackMktCap)) return fallbackMktCap;
  return null;
}

export default function AssetDetailScreen() {
  const { t, i18n } = useTranslation();
  const dc = useDisplayCurrency();
  const { coin, market: marketParam } = useLocalSearchParams<{ coin: string; market?: string }>();
  const router = useRouter();
  const { isAuthenticated, user } = useAppStore();
  // Trading env (mainnet | demo) — see profile.tsx for the toggle. Local
  // setup-complete state must re-evaluate on env flip because both the
  // SecureStore scope and HL's per-network agent / builder records change.
  const tradingEnv = useAppStore((s) => s.tradingEnv);
  const [isFavorite, setIsFavorite] = useState(false);
  const [isChartInteracting, setIsChartInteracting] = useState(false);
  const userAddress = user?.wallet?.address ?? null;
  const decodedCoin = decodeURIComponent(coin || '');
  const insets = useSafeAreaInsets();
  // When the top strip (claim or demo banner) is active it absolute-positions
  // over the very top of the screen. This page has no Header (which normally
  // pads itself accordingly), so we shift our SafeAreaView off the top edge
  // and pad explicitly by inset + strip height. Without this, the banner
  // overlaps the asset symbol/price.
  const topStripActive = useClaimBannerTopInset();
  const topStripContentHeight = useTopStripContentHeight();
  const topPadding = topStripActive ? insets.top + topStripContentHeight : 0;

  useFocusEffect(
    useCallback(() => {
      let isActive = true;
      (async () => {
        if (!isAuthenticated || !userAddress) {
          if (isActive) {
            setIsFavorite(false);
            setFavoriteCoins([]);
          }
          return;
        }
        const list = await loadFavorites(userAddress);
        if (isActive) {
          setIsFavorite(list.includes(decodedCoin));
          setFavoriteCoins(list);
        }
      })();
      return () => {
        isActive = false;
      };
    }, [decodedCoin, isAuthenticated, userAddress]),
  );

  const [showFundingModal, setShowFundingModal] = useState(false);
  const [showOpenInterestModal, setShowOpenInterestModal] = useState(false);
  const [showOracleModal, setShowOracleModal] = useState(false);
  const [showPreIpoModal, setShowPreIpoModal] = useState(false);
  const [showStockInfoModal, setShowStockInfoModal] = useState(false);
  const [showCryptoInfoModal, setShowCryptoInfoModal] = useState(false);
  const [showFullDesc, setShowFullDesc] = useState(false);
  const [cryptoInfoDescNeedsShowMore, setCryptoInfoDescNeedsShowMore] = useState(false);
  const grokStarAnim1 = useRef(new Animated.Value(0)).current;
  const grokStarAnim2 = useRef(new Animated.Value(0)).current;
  const grokStarAnim3 = useRef(new Animated.Value(0)).current;
  const [portfolioTab, setPortfolioTab] = useState<'positions' | 'orders' | 'history'>('positions');
  const [showSearch, setShowSearch] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [favoriteCoins, setFavoriteCoins] = useState<string[]>([]);
  const searchInputRef = useRef<TextInput>(null);
  const [cancelingOrderId, setCancelingOrderId] = useState<number | null>(null);
  const [closingPositionKey, setClosingPositionKey] = useState<string | null>(null);
  const [closeAllLoading, setCloseAllLoading] = useState(false);
  const [cancelAllLoading, setCancelAllLoading] = useState(false);
  /** Skeleton tail in PortfolioTabs while Quick Trade refetch lands a new row */
  const [portfolioTabsPendingRefresh, setPortfolioTabsPendingRefresh] = useState(false);
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
  const [pnlShareModal, setPnlShareModal] = useState<null | {
    symbol: string;
    direction: 'LONG' | 'SHORT';
    pnlPercent: number;
    entryPrice: number;
    markPrice: number;
    leverage?: number;
  }>(null);
  const [pnlShareLoading, setPnlShareLoading] = useState(false);
  const pnlShareRef = useRef<React.ElementRef<typeof ViewShot>>(null);
  const tradeNavPendingRef = useRef(false);
  const [showQuickTrade, setShowQuickTrade] = useState(false);
  const [showSetupModal, setShowSetupModal] = useState(false);
  const [setupLoading, setSetupLoading] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [setupComplete, setSetupComplete] = useState(false);
  const setupPromptTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [quickTradeSuccessAlert, setQuickTradeSuccessAlert] = useState<{
    title: string;
    message: string;
  } | null>(null);
  const quickTradeSuccessAlertTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Bottom sheet animation
  const sheetHeight = 600; // Large enough to ensure it moves completely off-screen
  const slideAnim = useRef(new Animated.Value(sheetHeight)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;
  const keyboardOffset = useRef(new Animated.Value(0)).current;
  
  // Pan responder for drag-to-dismiss
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_, gestureState) => {
          return gestureState.dy > 5;
        },
        onPanResponderMove: (_, gestureState) => {
          if (gestureState.dy > 0) {
            slideAnim.setValue(gestureState.dy);
          }
        },
        onPanResponderRelease: (_, gestureState) => {
          if (gestureState.dy > 80 || gestureState.vy > 0.4) {
            // Dismiss
            Animated.parallel([
              Animated.timing(slideAnim, {
                toValue: sheetHeight,
                duration: 200,
                useNativeDriver: true,
              }),
              Animated.timing(opacityAnim, {
                toValue: 0,
                duration: 200,
                useNativeDriver: true,
              }),
            ]).start(() => {
              setShowQuickTrade(false);
            });
          } else {
            // Snap back
            Animated.spring(slideAnim, {
              toValue: 0,
              useNativeDriver: true,
              bounciness: 4,
              speed: 20,
            }).start();
          }
        },
      }),
    [sheetHeight, slideAnim]
  );

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const handleShow = (event: any) => {
      const height = event?.endCoordinates?.height ?? 0;
      const base = Math.max(0, height - (insets.bottom || 0));
      const offset = -Math.min(180, base * 0.35);
      Animated.timing(keyboardOffset, {
        toValue: offset,
        duration: event?.duration ?? 250,
        useNativeDriver: true,
      }).start();
    };
    const handleHide = (event: any) => {
      Animated.timing(keyboardOffset, {
        toValue: 0,
        duration: event?.duration ?? 200,
        useNativeDriver: true,
      }).start();
    };
    const showSub = Keyboard.addListener(showEvent, handleShow);
    const hideSub = Keyboard.addListener(hideEvent, handleHide);
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [insets.bottom, keyboardOffset]);
  
  const openQuickTrade = useCallback(() => {
    Keyboard.dismiss();
    keyboardOffset.stopAnimation();
    keyboardOffset.setValue(0);
    slideAnim.setValue(sheetHeight); // Reset to bottom
    opacityAnim.setValue(0);
    setShowQuickTrade(true);
    // Small delay to ensure component renders first
    requestAnimationFrame(() => {
      Animated.parallel([
        Animated.spring(slideAnim, {
          toValue: 0,
          useNativeDriver: true,
          bounciness: 6,
          speed: 14,
        }),
        Animated.timing(opacityAnim, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    });
  }, [keyboardOffset, sheetHeight, slideAnim, opacityAnim]);
  
  const closeQuickTrade = useCallback(() => {
    Keyboard.dismiss();
    Animated.timing(keyboardOffset, {
      toValue: 0,
      duration: 150,
      useNativeDriver: true,
    }).start();
    Animated.parallel([
      Animated.timing(slideAnim, {
        toValue: sheetHeight,
        duration: 200,
        useNativeDriver: true,
      }),
      Animated.timing(opacityAnim, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start(() => {
      setShowQuickTrade(false);
    });
  }, [sheetHeight, slideAnim, opacityAnim, keyboardOffset]);

  useEffect(() => {
    if (!showQuickTrade) {
      keyboardOffset.stopAnimation();
      keyboardOffset.setValue(0);
    }
  }, [showQuickTrade, keyboardOffset]);

  const { data: asset, isLoading: assetLoading, isError: assetError } = useQuery({
    queryKey: ['asset', decodedCoin],
    queryFn: () => fetchAssetDetail(decodedCoin),
    enabled: !!decodedCoin,
    staleTime: 10_000,
    // Funding / OI / 24h stats in the header come from this payload (price
    // itself is WS) — keep the 30s cadence the old global default provided.
    refetchInterval: 30_000,
  });
  const isSpotOnly = asset?.isSpotOnly === true;
  // `market=spot` route param + asset has a matching spot book → render the
  // page in spot-aware mode. Spot-only assets already behave like this, so
  // we fold both cases into a single `isSpotModePage` derivation. If a coin
  // doesn't actually have a spot pair the param is ignored so we never
  // dead-end on a missing chart.
  const marketParamLower = (typeof marketParam === 'string' ? marketParam : Array.isArray(marketParam) ? marketParam[0] : '').toLowerCase();
  const hasSpotPair = !!asset?.spotSymbol || asset?.hasSpot === true;
  const isSpotModePage =
    demoAllowsSpot(tradingEnv) &&
    (isSpotOnly || (marketParamLower === 'spot' && hasSpotPair));

  // Spot asset context (markPx/midPx/szDecimals/@N symbol). Only fetched when
  // the page is in spot mode — perp renders keep their existing code paths.
  const spotPairForPage = asset?.spotSymbol || asset?.symbol || decodedCoin;
  const { data: spotAssetData } = useQuery({
    queryKey: ['hl_spot_asset', tradingEnv, spotPairForPage],
    queryFn: () => getSpotAssetData(spotPairForPage),
    enabled: isSpotModePage && !!spotPairForPage,
    staleTime: 15_000,
    // Spot-mode price fallback when the WS mid is missing — keep 30s fresh.
    refetchInterval: 30_000,
  });

  // Chart coin for spot mode: HL's candle endpoint accepts `@N` directly.
  // We keep `assetSymbol` as the human-readable display symbol so drawings
  // and position/order matching keep working for both @N and HYPE rows.
  const chartDecodedCoin = isSpotModePage
    ? (spotAssetData?.spotSymbol ?? asset?.spotSymbol ?? decodedCoin)
    : decodedCoin;

  // Fetch all assets for search — shared cache with home page
  const { data: rwaData } = useQuery({
    queryKey: ['assets'],
    queryFn: fetchAssets,
    staleTime: 30_000, // Already fetched on home page, no need to re-fetch immediately
  });

  const { data: cryptoData } = useQuery({
    queryKey: ['crypto-assets'],
    queryFn: fetchCryptoAssets,
    staleTime: 30_000,
    retry: false,
    retryOnMount: false,
    refetchOnWindowFocus: false,
  });

  const isCrypto = asset?.category === 'crypto';
  const isStock = asset?.category === 'stock';
  const hasAssetMeta = !!asset;
  const metaSymbol = asset?.symbol;
  const isKrwListedStock =
    !!metaSymbol && KRW_LISTED_STOCK_SYMBOLS.has(metaSymbol.toUpperCase());
  const { data: cryptoMeta } = useQuery({
    queryKey: ['crypto-metadata', metaSymbol],
    queryFn: () => fetchCryptoMetadata(metaSymbol!),
    enabled: hasAssetMeta && !isStock && !!metaSymbol,
    staleTime: 300_000,
    retry: false,
  });
  const { data: stockFundamentals } = useQuery({
    queryKey: ['stock-fundamentals', metaSymbol],
    queryFn: () => fetchStockFundamentals(metaSymbol!),
    // Pre-IPO still serves manual rows (description); Finnhub metrics stay null/TBA.
    enabled: hasAssetMeta && isStock && !!metaSymbol,
    staleTime: 300_000,
    retry: false,
  });
  const currentLang = i18n.language?.split('-')[0] || 'en';
  const { data: assetDesc } = useQuery({
    queryKey: ['asset-description', metaSymbol, currentLang],
    queryFn: () => fetchAssetDescription(metaSymbol!, currentLang),
    enabled: hasAssetMeta && !!metaSymbol && currentLang !== 'en',
    staleTime: 600_000,
    retry: false,
  });

  const cryptoInfoModalDescription = useMemo(() => {
    if (!hasAssetMeta) return '';
    if (isStock) {
      return (assetDesc?.description || stockFundamentals?.description || '').trim();
    }
    return (assetDesc?.description || cryptoMeta?.description || '').trim();
  }, [
    hasAssetMeta,
    isStock,
    assetDesc?.description,
    stockFundamentals?.description,
    cryptoMeta?.description,
  ]);

  /** Display ticker shown in the info modal header (backend-mapped, e.g. CL → OIL). */
  const infoModalXSearchSymbol = useMemo(() => {
    const sym = (asset?.symbol || '').trim();
    return sym ? sym.toUpperCase() : '';
  }, [asset?.symbol]);
  const infoModalXCashtag = infoModalXSearchSymbol ? `$${infoModalXSearchSymbol}` : '';

  useEffect(() => {
    setCryptoInfoDescNeedsShowMore(false);
  }, [cryptoInfoModalDescription]);

  // Pre-warm order caches when asset is loaded to reduce order placement latency
  // This runs in the asset page so cache is ready before user opens quick trade
  useEffect(() => {
    if (asset?.coin) {
      prewarmOrderCaches(asset.coin);
    }
  }, [asset?.coin]);

  const allAssets = useMemo(() => {
    const rwa = (rwaData?.assets || []).map((a: Asset) => ({ ...a, category: a.category || 'stock' }));
    const crypto = (cryptoData?.assets || []).map((a: Asset) => ({ ...a, category: 'crypto' }));
    return [...rwa, ...crypto];
  }, [rwaData?.assets, cryptoData?.assets]);

  // `activeAssetCtx` is a perp-only HL feed. Spot-only tickers (KNTQ, USDT)
  // and `?market=spot` pages must not subscribe — HL rejects with
  // `Invalid subscription {"type":"activeAssetCtx","coin":"KNTQ"}`. Spot
  // header marks come from allMids / spotAssetData instead.
  const headerAssetCtxCoins = useMemo(() => {
    if (!asset?.coin || isSpotModePage) return [];
    return [String(asset.coin)];
  }, [asset?.coin, isSpotModePage]);
  const headerAssetCtxs = useLiveAssetCtxs(headerAssetCtxCoins);
  const pricesRef = usePricesRef();
  const [selectedAllMidsPrice, setSelectedAllMidsPrice] = useState<number | undefined>(undefined);
  const [searchPricesTick, setSearchPricesTick] = useState(0);

  // Focus-gated: when another screen is pushed on top, this asset screen
  // stays mounted (expo-router stack) and the sampler used to keep ticking —
  // driving livePrice re-renders + chart WebView JS injections on a screen
  // nobody can see. On refocus the effect re-runs and reads the current WS
  // price synchronously, so the visible header/chart never miss a beat.
  const isScreenFocused = useIsFocused();
  useEffect(() => {
    if (!isScreenFocused) return;
    const readCurrentAssetPrice = () => {
      const priceMap = pricesRef.current;
      const raw = isSpotModePage
        ? (() => {
            const spotKey = spotAssetData?.spotSymbol ?? asset?.spotSymbol ?? null;
            return spotKey ? pickPrice(priceMap, { coin: spotKey }) : undefined;
          })()
        : pickPrice(priceMap, {
            coin: asset?.coin,
            symbol: asset?.symbol,
            isHip3: asset?.isHip3 === true,
          });
      const num = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''));
      const next = Number.isFinite(num) && num > 0 ? num : undefined;
      setSelectedAllMidsPrice((prev) => (Object.is(prev, next) ? prev : next));
    };

    readCurrentAssetPrice();
    const id = setInterval(readCurrentAssetPrice, ASSET_PRICE_SAMPLE_MS);
    return () => clearInterval(id);
  }, [
    asset?.coin,
    asset?.isHip3,
    asset?.spotSymbol,
    asset?.symbol,
    isScreenFocused,
    isSpotModePage,
    pricesRef,
    spotAssetData?.spotSymbol,
  ]);

  useEffect(() => {
    if (!showSearch) return;
    const id = setInterval(() => setSearchPricesTick((n) => n + 1), SEARCH_PRICE_SAMPLE_MS);
    return () => clearInterval(id);
  }, [showSearch]);

  const livePrice = useMemo(() => {
    // Spot mode: prefer the live spot mid from the shared allMids price map
    // (keyed by `@N` since HL includes spot mids under the first perp dex),
    // then fall back to the REST spot asset context. Never mix in perp
    // markPx — that's what caused the "chart says one price, top says
    // another" drift when a ticker has both a perp and a spot book.
    if (isSpotModePage) {
      const spotFromRest = spotAssetData?.midPx ?? spotAssetData?.markPx;
      const num = selectedAllMidsPrice != null
        ? selectedAllMidsPrice
        : (typeof spotFromRest === 'number' ? spotFromRest : NaN);
      return Number.isFinite(num) && num > 0 ? num : undefined;
    }
    const coin = asset?.coin ? String(asset.coin) : '';
    const liveCtx = coin ? headerAssetCtxs?.[coin] : undefined;
    const liveCtxFresh =
      liveCtx?.time != null && Date.now() - liveCtx.time <= HEADER_ASSET_CTX_FRESH_MS;
    const liveMark = liveCtxFresh ? liveCtx?.markPx : undefined;
    // HIP-3/RWA assets must not fall through to a bare allMids symbol.
    // A bare "MSTR" can belong to a different feed than "xyz:MSTR",
    // which made the header flip between two valid-looking prices. If the
    // per-asset mark feed stalls, fall back to allMids so the header doesn't
    // freeze while the chart keeps recovering from candle/mid updates.
    const raw = liveMark ?? selectedAllMidsPrice;
    const num = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''));
    return Number.isFinite(num) ? num : undefined;
  }, [asset?.coin, headerAssetCtxs, isSpotModePage, selectedAllMidsPrice, spotAssetData?.markPx, spotAssetData?.midPx]);

  const liveStockMktCap = useMemo(() => {
    if (!isStock) return null;
    const px =
      livePrice ??
      (asset?.markPx ? parseFloat(String(asset.markPx)) : NaN);
    return computeLiveStockMktCap(
      stockFundamentals?.outstanding_shares,
      Number.isFinite(px) ? px : null,
      stockFundamentals?.mkt_cap,
    );
  }, [
    isStock,
    livePrice,
    asset?.markPx,
    stockFundamentals?.outstanding_shares,
    stockFundamentals?.mkt_cap,
  ]);

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
  const { getAccessToken } = useAuth();
  const getUserWalletProvider = useCallback(async () => {
    if (!embeddedWallet) {
      throw new Error('Embedded wallet not available');
    }
    return (await embeddedWallet.getProvider()) as unknown as Eip1193Provider;
  }, [embeddedWallet]);

  // ─── Asset page onboarding guide ────────────────────────────────────
  const [assetObStep, setAssetObStep] = useState<0 | 1 | 2>(0);
  const assetObPulse = useRef(new Animated.Value(0)).current;
  const assetObCheckedRef = useRef(false);

  useEffect(() => {
    if (assetObCheckedRef.current) return;
    if (!isAuthenticated || !asset) return;
    if (asset.isSpotOnly || isSpotModePage) { assetObCheckedRef.current = true; return; }
    assetObCheckedRef.current = true;
    (async () => {
      const cached = await isAssetOnboardingCachedComplete();
      if (cached) return;
      try {
        const token = await getAccessToken();
        if (!token) return;
        const done = await fetchAssetOnboardingStatus(token);
        if (!done) setTimeout(() => setAssetObStep(1), 600);
      } catch { /* non-critical */ }
    })();
  }, [isAuthenticated, getAccessToken, asset]);

  useEffect(() => {
    if (assetObStep === 0) { assetObPulse.setValue(0); return; }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(assetObPulse, { toValue: 1, duration: 1000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(assetObPulse, { toValue: 0, duration: 1000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [assetObStep, assetObPulse]);

  const assetObScale = assetObPulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.15] });
  const assetObOpacity = assetObPulse.interpolate({ inputRange: [0, 1], outputRange: [0.7, 0] });
  const assetScrollRef = useRef<ScrollView>(null);

  const handleAssetObNext = useCallback(() => {
    if (assetObStep === 1) {
      setAssetObStep(2);
      setTimeout(() => assetScrollRef.current?.scrollTo({ y: 350, animated: true }), 300);
    }
  }, [assetObStep]);

  const handleAssetObDone = useCallback(async () => {
    setAssetObStep(0);
    try {
      const token = await getAccessToken();
      if (token) await completeAssetOnboarding(token);
    } catch { /* non-critical */ }
  }, [getAccessToken]);

  const handleResetAssetOnboarding = useCallback(async () => {
    await resetAssetOnboardingCache();
    assetObCheckedRef.current = false;
    setAssetObStep(1);
  }, []);

  // Single account WS retargets to active book (Main or Dedicated sub).
  const stream = useHyperliquidAccountStream();
  const streamMatchesBook =
    !!tradingAddress &&
    !!stream.subscribedUser &&
    stream.subscribedUser.toLowerCase() === tradingAddress.toLowerCase();

  // When WS is live, HL provides positions/account in real-time.
  // Reduce REST polling to infrequent safety-net refreshes.
  const hlWsLive = stream.isConnected;

  const { data: tradingState, refetch: refetchTradingState, isLoading: tradingStateLoading } = useQuery({
    queryKey: ['hl_trading_state', tradingEnv, tradingAddress],
    queryFn: () => getHyperliquidTradingState(tradingAddress),
    enabled: !!tradingAddress && isAuthenticated,
    staleTime: 5_000,
    refetchInterval: hlWsLive ? 30_000 : 8_000,
  });

  // True once the FIRST REST snapshot has landed (stays true across
  // refetches because react-query keeps `data` while re-fetching). Used
  // to gate setup-state writes/reads that depend on REST-only fields
  // (e.g. `accountAbstractionMode`) which the WS synthesizer can't
  // produce on its own. See trade/[coin].tsx for the full rationale.
  const tradingStateReady = !tradingStateLoading && !!tradingState;

  const { data: openOrders, refetch: refetchOpenOrders } = useQuery({
    queryKey: ['hl_open_orders', tradingEnv, tradingAddress],
    queryFn: () => getOpenOrders(tradingAddress),
    enabled: !!tradingAddress && isAuthenticated,
    staleTime: 5_000,
    refetchInterval: hlWsLive ? 30_000 : 8_000,
  });

  const { data: userFills, refetch: refetchUserFills } = useQuery({
    queryKey: ['hl_user_fills', tradingEnv, tradingAddress],
    queryFn: () => getUserFills(tradingAddress),
    enabled: !!tradingAddress && isAuthenticated,
    staleTime: 10_000,
    refetchInterval: 30_000,
  });

  const { data: userFunding } = useQuery({
    queryKey: ['hl_user_funding', tradingAddress],
    queryFn: () => getUserFunding(tradingAddress),
    enabled: !!tradingAddress && isAuthenticated,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  // Spot clearinghouse state for spot position data (fallback for stream.spotState)
  const { data: spotState, refetch: refetchSpotState } = useQuery({
    queryKey: ['hl_spot_state', tradingEnv, tradingAddress],
    queryFn: () => getSpotClearinghouseState(tradingAddress),
    enabled: !!tradingAddress && isAuthenticated,
    staleTime: 10_000,
    refetchInterval: hlWsLive ? 60_000 : 15_000,
  });

  const { data: spotSymbolMap } = useQuery({
    queryKey: ['hl_spot_symbol_map', tradingEnv],
    queryFn: getSpotSymbolMap,
    staleTime: 5 * 60 * 1000,
  });

  const bookTradingState = useMemo(() => {
    const hip3Positions = (tradingState?.positions ?? []).filter((p: any) => String(p.coin).includes(':'));
    if (streamMatchesBook && stream.isConnected && stream.clearinghouseState) {
      const ch: any = stream.clearinghouseState;
      const streamAccountValue = parseFloat(ch?.marginSummary?.accountValue ?? '0') || 0;
      const streamCrossAccountValue = parseFloat(ch?.crossMarginSummary?.accountValue ?? '0') || 0;
      const streamCrossMaintMarginUsed = parseFloat(ch?.crossMaintenanceMarginUsed ?? '0') || 0;
      const streamWithdrawable = parseFloat(ch?.withdrawable ?? '0') || 0;
      const accountValueUsd = Number.isFinite(tradingState?.accountValueUsd) ? tradingState!.accountValueUsd : streamAccountValue;
      const withdrawableUsd = Number.isFinite(tradingState?.withdrawableUsd) ? tradingState!.withdrawableUsd : streamWithdrawable;
      // PERP-only equity (spot excluded). Used as cross-margin
      // backing for liq projections. Stream only covers mainState; REST
      // sums main + HIP3 dex states, so prefer REST when available.
      const perpAccountValueUsd = Number.isFinite(tradingState?.perpAccountValueUsd)
        ? tradingState!.perpAccountValueUsd
        : streamAccountValue;
      // Per-dex cross-margin equity. The stream only carries mainState's
      // crossMarginSummary, so we seed key '' from the stream and merge
      // any HIP-3 dex values from the REST snapshot. Used as the equity
      // input to estimateLiqPriceCross — must NEVER be cross-summed
      // across dexes (HL keeps each dex's cross pool independent under
      // standard abstraction).
      // Build per-dex maps. We pull live values from BOTH the main
      // `clearinghouseState` (for ''/main) and `clearinghouseStatesByDex`
      // (which the WS stream also delivers for HIP-3 dexes via the
      // `allDexsClearinghouseState` subscription — see
      // `useHyperliquidAccountStream`). This gives HIP-3 assets the same
      // sub-second freshness for cross-liq projections that main-dex gets,
      // instead of falling back to the 5s REST polling cadence.
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

      // Standard per-dex cross liq uses account_value minus cross
      // maintenance. Exclude isolated margin from the same dex, but do
      // not rely on crossMarginSummary.accountValue for order preview:
      // live testing showed it can be far below the actual cross-backed
      // account value once cross positions exist.
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
      // `marginSummary.totalMarginUsed` only reflects FILLED positions,
      // so resting limits on this dex would otherwise look free even
      // though their init margin is reserved. Without this the
      // QuickTradeCard slider for HIP-3 assets overstates `targetDexBalance`
      // and HL rejects the order at submit.
      const restingOrdersInitMarginByDex = estimateRestingOrdersInitMarginByDex(stream.openOrders as any[]);
      for (const [dex, lock] of Object.entries(restingOrdersInitMarginByDex)) {
        if (perpInitialMarginAvailableByDex[dex] == null) continue;
        perpInitialMarginAvailableByDex[dex] = Math.max(
          0,
          perpInitialMarginAvailableByDex[dex] - (Number.isFinite(lock) ? lock : 0),
        );
      }
      // Unified-pool aggregates (live). Computed across every dex in the
      // stream — main + HIP-3 — so unified-mode liq projections see the
      // same maintenance-margin pool HL itself uses. Falls back to the
      // REST `tradingState` snapshot if a value isn't in the stream yet.
      const totalCrossMaintenanceMarginUsedUsd = Object.values(perpCrossMaintenanceMarginUsedByDex)
        .reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0);
      const totalIsolatedMarginUsedUsd = Object.values(isolatedMarginUsedByDex)
        .reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0);
      // Total INITIAL margin used across every dex. Pairs with
      // `unifiedSpotTransferableUsd` below to mirror HL's strict spot-out
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
      // Resting (non-reduce-only / non-trigger / non-position-tpsl) limit
      // orders also count toward `position_value` in HL's transfer rule
      // (`max(initial, 0.10 × position_value)`). Without including them,
      // a user with a $300 resting BTC limit and no positions still has
      // $30 of spot locked, but our slider/JIT pre-check would think the
      // full pool is transferable and HL would reject the sendAsset.
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
      // Spot USDC only (excludes other coins). Live from stream.spotState
      // when available, falling back to REST.
      const spotState = stream.spotState ?? null;
      const spotUsdcBalanceUsd = spotState
        ? (() => {
            let total = 0;
            (spotState?.balances ?? []).forEach((b: any) => {
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
          marginType,
          cumFunding: p.position?.cumFunding ?? restCumFundingMap.get(p.position.coin) ?? null,
        };
      });
      // Live HIP-3 positions from `clearinghouseStatesByDex` (same WS
      // subscription as the per-dex margin maps above) so HIP-3 gets the
      // same sub-second freshness as main-dex.
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
            marginType,
            cumFunding: p.position?.cumFunding ?? restCumFundingMap.get(p.position.coin) ?? null,
          });
        });
      });
      const merged = new Map<string, any>();
      // Order: REST hip3 (oldest) → live stream hip3 (newer) → live main
      // (newest). Later writes win on key collision so live values trump
      // stale REST. Key by coin only (HL one-way mode → one position per
      // coin).
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
      //   spotUsdc − isolated − cross init (positions) − resting orders init
      // Stream-driven so the slider reacts the moment a limit is placed
      // or cancelled. See `[coin].tsx (trade)` for the full rationale.
      const restingOrdersInitMarginUsdLive = estimateRestingOrdersInitMarginUsd(stream.openOrders as any);
      // Resting limit orders' init margin is also locked out of the
      // spot pool for the HIP-3 `sendAsset` transfer cap. Without
      // passing it here the slider would treat those locks as free.
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
        spotUsdcBalanceUsd,
        spotUsdcHoldUsd,
        totalIsolatedMarginUsedUsd,
        totalCrossMaintenanceMarginUsedUsd,
        totalCrossInitialMarginUsedUsd,
        totalCrossPositionValueUsd,
        restingOrdersInitMarginUsd: restingOrdersInitMarginUsdLive,
        unifiedSpotTransferableUsd,
        withdrawableUsd: withdrawableUsdEffective,
        hasBalance,
        isAgentActive: tradingState?.isAgentActive ?? false,
        positions: orderedPositions,
      };
    }
    return tradingState;
  }, [
    streamMatchesBook,
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

  const filteredFills = useMemo(() => (userFills ?? []) as any[], [userFills]);

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

  /** Merge REST + WS Hyperliquid spot balances for PortfolioTabs. */
  const combinedSpotBalances = useMemo(() => {
    const restBals = (spotState?.balances ?? []) as any[];
    const restEscrows = (spotState?.evmEscrows ?? []) as any[];
    const streamBals = (stream.spotState?.balances ?? []) as any[];
    const streamEscrows = (stream.spotState?.evmEscrows ?? []) as any[];
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
    return Array.from(byCoin.values()) as any[];
  }, [stream.spotState?.balances, stream.spotState?.evmEscrows, spotState?.balances, spotState?.evmEscrows]);

  const liveCoins = useMemo(() => {
    const coins = [
      ...(filteredPositions ?? []).map((p: any) => String(p.coin)),
      ...(filteredOpenOrders ?? []).map((o: any) => String(o.coin)),
    ];
    const spotBalancesSource = stream.spotState?.balances ?? spotState?.balances ?? [];
    const byBase = spotSymbolMap?.byBase ?? {};
    spotBalancesSource.forEach((b: any) => {
      const base = String(b?.coin ?? '').toUpperCase();
      if (base && base !== 'USDC') {
        coins.push(base);
        if (base.startsWith('U') && base.length > 1) {
          coins.push(base.slice(1));
        }
        const spotSym = byBase[base];
        if (spotSym) coins.push(spotSym);
      }
    });
    const uniq = Array.from(new Set(coins)).filter(Boolean) as string[];
    uniq.sort();
    return uniq;
  }, [filteredOpenOrders, filteredPositions, spotState?.balances, spotSymbolMap?.byBase, stream.spotState?.balances]);

  // Minimal synthesized spot position for the CURRENT ticker, so AssetChart
  // can render entry/size lines in spot mode. HL only reports spot balances
  // (not positions), so we derive entry price from the fills-based cost
  // basis — same logic PortfolioTabs uses for its spot rows. We only emit
  // this when the page is in spot mode AND the user actually holds the
  // base coin; otherwise the chart falls back to perp-only position data.
  const spotPositionsForChart = useMemo<any[]>(() => {
    if (!isSpotModePage) return [];
    const balances = stream.spotState?.balances ?? spotState?.balances ?? [];
    if (!Array.isArray(balances) || balances.length === 0) return [];
    const byBase = spotSymbolMap?.byBase ?? {};
    const bySymbol = spotSymbolMap?.bySymbol ?? {};
    const szDecimalsBySymbol = spotSymbolMap?.szDecimalsBySymbol ?? {};
    const szDecimalsByBase = spotSymbolMap?.szDecimalsByBase ?? {};
    const targetSpotSym = spotAssetData?.spotSymbol ?? asset?.spotSymbol ?? null;
    const targetBase = (spotAssetData?.baseCoin
      ?? (targetSpotSym ? bySymbol?.[targetSpotSym]?.baseCoin : undefined)
      ?? asset?.symbol
      ?? '')
      .toUpperCase();
    if (!targetBase) return [];
    const bal = balances.find((b: any) => String(b?.coin ?? '').toUpperCase() === targetBase);
    if (!bal) return [];
    const total = parseFloat(String(bal?.total ?? '0'));
    if (!Number.isFinite(total) || total <= 0) return [];
    const spotSymbol = targetSpotSym ?? byBase[targetBase];
    const szDec = Number(szDecimalsBySymbol[spotSymbol ?? ''] ?? szDecimalsByBase[targetBase]);
    const minLot = Number.isFinite(szDec) ? Math.pow(10, -szDec) : 0;
    if (Number.isFinite(minLot) && minLot > 0 && total < minLot) return [];

    // Fills-based cost basis. HL returns @N-prefixed coins on spot fills.
    const fills = Array.isArray(userFills) ? userFills : [];
    let qty = 0;
    let cost = 0;
    const sorted = [...fills].sort((a: any, b: any) => Number(a?.time ?? 0) - Number(b?.time ?? 0));
    for (const raw of sorted) {
      const f = raw as any;
      const c = String(f?.coin ?? f?.symbol ?? '');
      if (!c.startsWith('@')) continue;
      const fillBase = bySymbol?.[c]?.baseCoin?.toUpperCase();
      if (fillBase !== targetBase) continue;
      const px = parseFloat(String(f?.px ?? f?.price ?? f?.fillPx ?? '0'));
      const sz = Math.abs(parseFloat(String(f?.sz ?? f?.size ?? f?.qty ?? '0')));
      if (!Number.isFinite(px) || !Number.isFinite(sz) || sz <= 0) continue;
      const sideRaw = String(f?.side ?? f?.dir ?? f?.orderSide ?? '').toLowerCase();
      const isBuy = sideRaw === 'b' || sideRaw === 'buy' || sideRaw === 'long';
      if (isBuy) {
        cost += sz * px;
        qty += sz;
      } else if (qty > 0) {
        const sold = Math.min(qty, sz);
        const reduceCost = (cost * sold) / Math.max(1e-9, qty);
        cost -= reduceCost;
        qty -= sold;
        if (qty <= 1e-12) {
          qty = 0;
          cost = 0;
        }
      }
    }
    const entryPx = qty > 0 ? cost / qty : NaN;
    if (!Number.isFinite(entryPx)) return [];

    return [{
      coin: spotSymbol ?? targetBase,
      baseCoin: targetBase,
      spotSymbol,
      isSpot: true,
      entryPx,
      szi: String(total),
      sizeUnits: total,
    }];
  }, [
    isSpotModePage,
    stream.spotState?.balances,
    spotState?.balances,
    spotSymbolMap,
    spotAssetData?.spotSymbol,
    spotAssetData?.baseCoin,
    asset?.spotSymbol,
    asset?.symbol,
    userFills,
  ]);
  const hip3Prices = useMemo(() => {
    const map: Record<string, string> = {};
    const assets = rwaData?.assets ?? [];
    assets.forEach((a: any) => {
      if (a?.isHip3 && a?.coin && a?.markPx) {
        map[String(a.coin)] = String(a.markPx);
      }
    });
    return map;
  }, [rwaData]);

  // Ref for price-dependent callbacks; reading it does not subscribe this page
  // to global allMids React updates.
  const livePricesRef = pricesRef;
  const hip3PricesRef = useRef(hip3Prices);
  useEffect(() => { hip3PricesRef.current = hip3Prices; }, [hip3Prices]);

  const fundingRates = useMemo(() => {
    const map: Record<string, string> = {};
    allAssets.forEach((a: any) => {
      if (a?.coin && a?.funding != null) {
        map[String(a.coin)] = String(a.funding);
      }
    });
    if (asset?.coin && asset?.funding != null) {
      map[String(asset.coin)] = String(asset.funding);
    }
    return map;
  }, [allAssets, asset?.coin, asset?.funding]);

  // Current position for this asset (for quick trade)
  const currentPosition = useMemo(() => {
    if (!asset) return null;
    const normalize = (v?: string) => (v ?? '').toLowerCase();
    const candidates = [asset?.coin, asset?.symbol, decodedCoin]
      .filter(Boolean)
      .map((v) => normalize(String(v)));
    const pos = filteredPositions.find((p: any) => candidates.includes(normalize(String(p?.coin))));
    if (!pos) return null;
    const rawSize = parseFloat(String(pos?.szi ?? 0));
    if (!Number.isFinite(rawSize) || rawSize === 0) return null;
    const posSide: 'long' | 'short' = rawSize >= 0 ? 'long' : 'short';
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
    const rawLiqPx = parseFloat(String(pos?.liquidationPx ?? ''));
    const liquidationPx = Number.isFinite(rawLiqPx) && rawLiqPx > 0 ? rawLiqPx : undefined;
    return {
      entryPx,
      side: posSide,
      sizeUnits: Math.abs(rawSize),
      leverage,
      marginUsedUsd,
      markPx,
      marginType,
      liquidationPx,
    };
  }, [asset, decodedCoin, filteredPositions]);

  // Resting limit orders for the current asset pin its margin mode and
  // leverage at HL's per-asset level. We surface the first matching
  // order's settings so QuickTradeCard can mute the conflicting toggles
  // BEFORE the user places a market order that would silently mutate the
  // resting limit (cross→isolated, 20x→10x, etc).
  const restingOrderLockForCoin = useMemo(() => {
    if (!asset) return null;
    const normalize = (v?: string) => (v ?? '').toLowerCase();
    const candidates = [asset?.coin, asset?.symbol, decodedCoin]
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
    return { marginType: lockedMarginType, leverage: lockedLeverage };
  }, [asset, decodedCoin, filteredOpenOrders]);

  const handleQuickTradeToggle = useCallback(() => {
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    if (!isAuthenticated) {
      router.push('/login');
      return;
    }
    if (showQuickTrade) {
      closeQuickTrade();
    } else {
      openQuickTrade();
    }
  }, [closeQuickTrade, isAuthenticated, openQuickTrade, router, showQuickTrade]);

  const showQuickTradeOrderSuccessAlert = useCallback(() => {
    if (quickTradeSuccessAlertTimeoutRef.current) {
      clearTimeout(quickTradeSuccessAlertTimeoutRef.current);
    }
    setQuickTradeSuccessAlert({
      title: t('trading.orderSubmitted'),
      message: t('trading.orderSubmittedSuccess'),
    });
    quickTradeSuccessAlertTimeoutRef.current = setTimeout(() => {
      setQuickTradeSuccessAlert(null);
      quickTradeSuccessAlertTimeoutRef.current = null;
    }, 3000);
  }, [t]);

  const handleQuickTradeOrderSuccess = useCallback(async () => {
    // Parallel refetches so the Buy/Sell button in QuickTradeCard can await
    // this and keep its spinner alive until the new row shows up in
    // PortfolioTabs — closing the gap between "Order submitted" toast and
    // the order appearing. Fetches are already short-circuited by the
    // individual queries' staleTime caches if nothing changed.
    setPortfolioTabsPendingRefresh(true);
    try {
      await Promise.allSettled([
        refetchTradingState(),
        refetchOpenOrders(),
        // Spot fills update balances + establish entry cost for PnL, both
        // needed so a freshly-opened spot position lands with the right entry
        // on the first render.
        refetchSpotState(),
        refetchUserFills(),
      ]);
    } finally {
      setPortfolioTabsPendingRefresh(false);
    }
  }, [refetchOpenOrders, refetchSpotState, refetchTradingState, refetchUserFills]);

  useEffect(() => {
    return () => {
      if (quickTradeSuccessAlertTimeoutRef.current) {
        clearTimeout(quickTradeSuccessAlertTimeoutRef.current);
      }
    };
  }, []);

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

  const handleSetupTrading = useCallback(async () => {
    if (!embeddedWallet) {
      setSetupError(t('errors.walletNotReadyDescription'));
      return;
    }
    try {
      setSetupError(null);
      setSetupLoading(true);
      pauseAutoSetup();
      const rotated = await rotateAgentKey();
      const provider = (await embeddedWallet.getProvider()) as unknown as Eip1193Provider;
      await setupTradingAccount({
        userWalletProvider: provider,
        userAddress: embeddedAddress,
        agentAddress: rotated.agentAddress as `0x${string}`,
        agentPrivateKey: rotated.agentPrivateKey as `0x${string}`,
      });

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
        setSetupError(t('errors.setupNotConfirmed'));
        setShowSetupModal(true);
      }
    } catch (e: any) {
      setSetupError(e?.message ? String(e.message) : t('errors.setupFailed'));
    } finally {
      setSetupLoading(false);
      resumeAutoSetup();
    }
  }, [embeddedAddress, embeddedWallet, refetchTradingState, pauseAutoSetup, resumeAutoSetup]);

  useEffect(() => {
    // Re-read on env flip — see comment in trade/[coin].tsx.
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
    // Mark setup complete only when agent, builder fee, and unified/portfolio
    // mode are all confirmed. See trade/[coin].tsx for the full rationale — this guards
    // against the "agent active but builder not approved" lockout where
    // HL would silently reject orders with "builder fee has not been
    // approved" while the cached setupComplete=true flag suppresses the
    // setup modal that would let the user re-approve.
    //
    // Bail out while REST tradingState hasn't shipped yet. During the
    // mount window the WS-derived `effectiveTradingState` may report
    // `isAgentActive=true` while `accountAbstractionMode` is still null
    // (REST-only field), which would falsely downgrade an already-correct
    // `setupComplete=true` and pop the seamless-trading modal even
    // though nothing changed on HL.
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
    // Wait for `accountAbstractionMode` to settle: the WS synthesizer
    // falls back to `tradingState?.accountAbstractionMode ?? null` for
    // a tick after a refetch. Letting the next render with a confirmed
    // value drive the decision avoids transient false downgrades.
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
          setSetupComplete(false);
        }
      } catch {
        // Network failure → leave as-is.
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

  // Silent seamless-trading setup. With Privy embedded wallets the approvals
  // sign without a popup and the builder fee is disclosed in the ToS, so we
  // enable trading in the background (and auto-renew before agent expiry)
  // instead of prompting. The modal below is now only a FALLBACK for when a
  // silent first-run attempt fails.

  // Active Trader state machine: if user has balance but setup is not
  // complete => prompt to setup. Gates on `!setupComplete` (agent active +
  // builder fee approved + unified/portfolio) instead of `!isAgentActive`,
  // so users with active agent but unapproved builder fee get re-prompted
  // to complete setup. See trade/[coin].tsx for the full rationale.
  //
  // We also wait for `tradingStateReady` before arming the prompt
  // timer: WS-derived `hasBalance` can be true on mount before REST
  // ships `accountAbstractionMode`, and the auto-mark effect above
  // can't confirm setupComplete in that window. Without this guard
  // the modal could pop transiently before settling closed.
  useEffect(() => {
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
        // Only surface the modal if the silent setup actually failed; while
        // it's in flight (or hasn't failed) we stay quiet.
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

  // Gemini logo animation (sparkling stars effect)
  useEffect(() => {
    const createStarAnimation = (animValue: Animated.Value, delay: number) => {
      return Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(animValue, {
            toValue: 1,
            duration: 800,
            useNativeDriver: true,
          }),
          Animated.timing(animValue, {
            toValue: 0,
            duration: 800,
            useNativeDriver: true,
          }),
        ])
      );
    };

    const anim1 = createStarAnimation(grokStarAnim1, 0);
    const anim2 = createStarAnimation(grokStarAnim2, 400);
    const anim3 = createStarAnimation(grokStarAnim3, 800);

    anim1.start();
    anim2.start();
    anim3.start();

    return () => {
      anim1.stop();
      anim2.stop();
      anim3.stop();
    };
  }, [grokStarAnim1, grokStarAnim2, grokStarAnim3]);

  const star1Opacity = grokStarAnim1.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [0.3, 1, 0.3],
  });
  const star2Opacity = grokStarAnim2.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [0.3, 1, 0.3],
  });
  const star3Opacity = grokStarAnim3.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [0.3, 1, 0.3],
  });

  const handleBack = useCallback(() => {
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    router.back();
  }, [router]);

  const handleTrade = useCallback(() => {
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    if (tradeNavPendingRef.current) {
      return;
    }
    if (!isAuthenticated) {
      router.push('/login');
    } else {
      tradeNavPendingRef.current = true;
      // Preserve spot mode when navigating to the full trade page so the
      // Trade screen lands on the spot side (market toggle, order book,
      // spot balance) instead of defaulting back to perp.
      const tradeSuffix = isSpotModePage && !isSpotOnly ? '?market=spot' : '';
      router.push(`/trade/${encodeURIComponent(decodedCoin)}${tradeSuffix}`);
      setTimeout(() => {
        tradeNavPendingRef.current = false;
      }, 800);
    }
  }, [isAuthenticated, router, decodedCoin, isSpotModePage, isSpotOnly]);

  const handleSearchToggle = useCallback(() => {
    setShowSearch(true);
  }, []);

  const handleSearchClose = useCallback(() => {
    setShowSearch(false);
    setSearchText('');
    setDebouncedSearch('');
    Keyboard.dismiss();
  }, []);

  // Removed useEffect - using onShow callback instead

  useEffect(() => {
    const id = setTimeout(() => {
      setDebouncedSearch(searchText.trim());
    }, 300);
    return () => clearTimeout(id);
  }, [searchText]);

  const searchResults = useMemo(() => {
    const query = debouncedSearch.toLowerCase();
    if (!query) return [];
    const searchPool = (tradingEnv === 'demo'
      ? allAssets.filter(
          (asset) =>
            !asset.isSpotOnly && DEMO_PERP_BASE_WHITELIST.has(getDemoBaseSymbol(asset)),
        )
      : allAssets
    ).filter((a) => !isHiddenLowLiquidityGoldSpotAsset(a));
    const results = searchPool.filter((asset) => {
      const coin = asset.coin?.toLowerCase() ?? '';
      const symbol = asset.symbol?.toLowerCase() ?? '';
      const name = asset.name?.toLowerCase() ?? '';
      return coin.includes(query) || symbol.includes(query) || name.includes(query);
    });
    
    // Sort by priority: exact symbol match > symbol starts with > symbol contains > coin match > name match    
    const sortedPerps = [...results].sort((a, b) => {
      const aSymbol = (a.symbol?.toLowerCase() ?? '');
      const bSymbol = (b.symbol?.toLowerCase() ?? '');
      const aCoin = (a.coin?.toLowerCase() ?? '');
      const bCoin = (b.coin?.toLowerCase() ?? '');
      const aName = (a.name?.toLowerCase() ?? '');
      const bName = (b.name?.toLowerCase() ?? '');
      
      // Exact symbol match
      const aExactSymbol = aSymbol === query;
      const bExactSymbol = bSymbol === query;
      if (aExactSymbol && !bExactSymbol) return -1;
      if (!aExactSymbol && bExactSymbol) return 1;
      
      // Symbol starts with query
      const aSymbolStarts = aSymbol.startsWith(query);
      const bSymbolStarts = bSymbol.startsWith(query);
      if (aSymbolStarts && !bSymbolStarts) return -1;
      if (!aSymbolStarts && bSymbolStarts) return 1;
      
      // Symbol contains query
      const aSymbolContains = aSymbol.includes(query);
      const bSymbolContains = bSymbol.includes(query);
      if (aSymbolContains && !bSymbolContains) return -1;
      if (!aSymbolContains && bSymbolContains) return 1;
      
      // Coin match
      const aCoinMatch = aCoin.includes(query);
      const bCoinMatch = bCoin.includes(query);
      if (aCoinMatch && !bCoinMatch) return -1;
      if (!aCoinMatch && bCoinMatch) return 1;
      
      // Name match (lowest priority)
      const aNameMatch = aName.includes(query);
      const bNameMatch = bName.includes(query);
      if (aNameMatch && !bNameMatch) return -1;
      if (!aNameMatch && bNameMatch) return 1;
      
      return aSymbol.localeCompare(bSymbol);
    });
    return expandAssetSearchRows(sortedPerps, { allowSpot: demoAllowsSpot(tradingEnv) });
  }, [debouncedSearch, allAssets, tradingEnv]);

  const handleSearchSelect = useCallback((selectedAsset: AssetSearchRow) => {
    handleSearchClose();
    const goSpot = demoAllowsSpot(tradingEnv) && selectedAsset.searchMarket === 'spot';
    const sameTicker = selectedAsset.coin === decodedCoin;
    if (sameTicker) {
      if (goSpot === isSpotModePage) return;
      router.replace(
        goSpot
          ? { pathname: '/asset/[coin]', params: { coin: selectedAsset.coin, market: 'spot' } }
          : { pathname: '/asset/[coin]', params: { coin: selectedAsset.coin } },
      );
      return;
    }
    router.replace(
      goSpot
        ? { pathname: '/asset/[coin]', params: { coin: selectedAsset.coin, market: 'spot' } }
        : { pathname: '/asset/[coin]', params: { coin: selectedAsset.coin } },
    );
  }, [decodedCoin, handleSearchClose, isSpotModePage, router, tradingEnv]);

  const handleSearchFavoriteToggle = useCallback(async (selectedAsset: Asset, e: any) => {
    e.stopPropagation();
    if (!isAuthenticated || !userAddress) {
      router.push('/login');
      return;
    }
    const next = await toggleFavorite(userAddress, selectedAsset.coin);
    setFavoriteCoins(next.favorites);
    if (selectedAsset.coin === decodedCoin) {
      setIsFavorite(next.isFavorite);
    }
  }, [isAuthenticated, userAddress, router, decodedCoin]);

  const formatSearchPrice = useCallback((price: string | number | null | undefined): string => {
    if (!price) return '--';
    const num = typeof price === 'string' ? parseFloat(price) : price;
    if (!Number.isFinite(num)) return '--';
    return dc.formatDisplayPrice(num);
  }, [dc.formatDisplayPrice]);

  const formatSearchChange = useCallback((change: number | null | undefined): string => {
    if (change === null || change === undefined) return '--';
    const sign = change >= 0 ? '+' : '';
    return `${sign}${change.toFixed(2)}%`;
  }, []);

  const favoriteSet = useMemo(() => new Set(favoriteCoins), [favoriteCoins]);

  const formatPrice = (price: string | null | undefined): string => {
    if (!price) return '--';
    return dc.formatDisplayPrice(parseFloat(price));
  };

  const formatChange = (change: number | null | undefined): string => {
    if (change === null || change === undefined) return '--';
    const sign = change >= 0 ? '+' : '';
    return `${sign}${change.toFixed(2)}%`;
  };

  const formatVolume = (volume: string | null | undefined): string => {
    if (!volume) return '--';
    return dc.formatDisplayVolume(parseFloat(volume));
  };

  const openInterestUsd = (() => {
    const oiBase = parseFloat(asset?.openInterest || '0'); // typically base-asset units
    const px = parseFloat(asset?.markPx || asset?.oraclePx || '0');
    if (!Number.isFinite(oiBase) || !Number.isFinite(px)) return null;
    return oiBase * px;
  })();

  const effectiveFunding = asset?.funding;
  const effectiveOraclePx = asset?.oraclePx;
  const effectiveVolume = asset?.dayNtlVlm;

  const formatFunding = (funding: string | null | undefined): string => {
    if (!funding) return '--';
    const num = parseFloat(funding) * 100;
    return `${num.toFixed(4)}%`;
  };

  const formatPriceNum = (n: number | null | undefined): string => {
    if (n === null || n === undefined || !Number.isFinite(n)) return '--';
    return dc.formatDisplayPrice(n);
  };

  /** Position size in base units — not a currency price; avoid $ / display-currency glyph. */
  const formatAssetUnits = (n: number | null | undefined): string => {
    if (n === null || n === undefined || !Number.isFinite(n)) return '--';
    const abs = Math.abs(n);
    const maxFrac = abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 6 : 8;
    return n.toLocaleString('en-US', { maximumFractionDigits: maxFrac });
  };

  const safeNum = (x: any) => {
    const n = typeof x === 'number' ? x : parseFloat(String(x ?? ''));
    return Number.isFinite(n) ? n : NaN;
  };

  const formatSignedUsd = (n: number): string => {
    if (!Number.isFinite(n)) return '--';
    return dc.formatDisplaySigned(n);
  };

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

  const handleCancelOrder = useCallback(async (symbol: string, oid: number) => {
    if (!embeddedAddress) {
      showToast(t('errors.pleaseConnectWallet'));
      return;
    }
    try {
      setCancelingOrderId(oid);
      const { agentPrivateKey } = await ensureAgentKey();
      await cancelOpenOrder({
        agentPrivateKey: agentPrivateKey as `0x${string}`,
        symbol,
        oid,
        vaultAddress,
      });
      await refetchOpenOrders();
      showToast(t('trading.orderCancelled'));
    } catch (e: any) {
      showToast(e?.message ? String(e.message) : t('errors.cancelFailed'), t('errors.cancelFailed'));
    } finally {
      setCancelingOrderId(null);
    }
  }, [embeddedAddress, refetchOpenOrders, vaultAddress]);

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
    if (!embeddedAddress) {
      showToast(t('errors.pleaseConnectWallet'));
      return;
    }
    try {
      const { agentPrivateKey } = await ensureAgentKey();
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
  }, [embeddedAddress, refetchOpenOrders, vaultAddress]);

  const handleMarketClose = useCallback(async (symbol: string, szi: string) => {
    if (!embeddedAddress || !embeddedWallet) {
      showToast(t('errors.pleaseConnectWallet'));
      return;
    }
    try {
      setClosingPositionKey(`${symbol}:${szi}`);
      const { agentPrivateKey } = await ensureAgentKey();
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
        // Spot close doesn't show up in tradingState.positions or openOrders —
        // it lands in spotState.balances and fills. Without these, the spot
        // row in PortfolioTabs keeps its pre-close balance (and stale PnL /
        // entry that's computed from fills) until the next poll tick or a
        // screen re-mount forces a refetch.
        refetchSpotState(),
        refetchUserFills(),
      ]);
      // Report trade for rewards tracking (fire-and-forget)
      if (embeddedAddress) {
        getAccessToken().then((token) => {
          if (token) reportTrade(embeddedAddress!, token).catch(() => {});
        });
      }
      showToast(t('portfolio.positionClosed'));
    } catch (e: any) {
      const h = humanizeHyperliquidError(e?.message ? String(e.message) : '');
      showToast(h.message, h.title);
    } finally {
      setClosingPositionKey(null);
    }
  }, [embeddedAddress, embeddedWallet, refetchOpenOrders, refetchSpotState, refetchTradingState, refetchUserFills, getAccessToken, vaultAddress]);

  const handleCloseAllPositions = useCallback(async () => {
    if (!embeddedAddress || !embeddedWallet) {
      showToast(t('errors.pleaseConnectWallet'));
      return;
    }
    try {
      setCloseAllLoading(true);

      const hlPos = filteredPositions;

      if (hlPos.length > 0) {
        const { agentPrivateKey } = await ensureAgentKey();

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
            (livePricesRef.current?.[spotSymbol]?.price ?? hip3PricesRef.current?.[spotSymbol]);
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
        // Price lookup goes through `pickPrice` so HIP-3 namespaced keys
        // (`xyz:SYMBOL`) resolve correctly — the prior bare-symbol ref
        // access would silently miss HIP-3 entries, forcing the lib's
        // metaAndAssetCtxs fallback every time.
        // 429 backoff is ~6s (HL throttles abused addresses to 1/10s);
        // 200ms inter-leg pacing avoids triggering the throttle to begin
        // with. See `isRateLimitError` in hyperliquid.ts.
        for (let i = 0; i < hlPos.length; i++) {
          const p = hlPos[i];
          const symbol = String(p?.coin ?? '');
          const szi = String(p?.szi ?? '');
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
          const symbolLivePrice = livePricesRef.current?.[sp.symbol]?.price ?? hip3PricesRef.current?.[sp.symbol];
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
      // Report trade for rewards tracking (fire-and-forget)
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
  }, [embeddedAddress, embeddedWallet, filteredPositions, refetchOpenOrders, refetchSpotState, refetchTradingState, refetchUserFills, spotState?.balances, spotSymbolMap?.byBase, stream.spotState?.balances, getAccessToken, vaultAddress]);

  const handleCancelAllOrders = useCallback(async () => {
    if (!embeddedAddress) {
      showToast(t('errors.pleaseConnectWallet'));
      return;
    }
    try {
      setCancelAllLoading(true);
      const { agentPrivateKey } = await ensureAgentKey();
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
  }, [embeddedAddress, filteredOpenOrders, refetchOpenOrders, vaultAddress]);

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

  // When the top strip is active we skip the safe-area top edge and pad by
  // (insets.top + strip content height) so the strip can absolute-position
  // over our top region without overlapping content. Otherwise default
  // SafeAreaView behaviour.
  const safeAreaEdges = (topStripActive ? ['left', 'right', 'bottom'] : undefined) as
    | undefined
    | ('top' | 'bottom' | 'left' | 'right')[];
  const safeAreaTopPad = topStripActive ? { paddingTop: topPadding } : undefined;

  if (assetLoading) {
    return (
      <SafeAreaView style={[styles.container, safeAreaTopPad]} edges={safeAreaEdges}>
        <View style={styles.loadingContainer}>
          <LoadingIndicator size="medium" />
        </View>
      </SafeAreaView>
    );
  }

  if (assetError || !asset) {
    return (
      <SafeAreaView style={[styles.container, safeAreaTopPad]} edges={safeAreaEdges}>
        <View style={styles.header}>
          <TouchableOpacity onPress={handleBack} style={styles.backButton}>
            <Ionicons name="arrow-back" size={24} color={colors.text.primary} />
          </TouchableOpacity>
        </View>
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{t('errors.failedToLoadAsset')}</Text>
          <TouchableOpacity onPress={handleBack} style={styles.retryButton}>
            <Text style={styles.retryText}>{t('common.goBack')}</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const leverageColor = getLeverageColor(asset.maxLeverage);
  const isUltraLeverage = asset.maxLeverage >= 40;
  const showLeverageFlash = asset.maxLeverage > 25;
  const showPreIpoBadge = asset.isPreIpo === true && !isSpotModePage;
  const changeColor = getPriceChangeColor(asset.change24h);

  return (
    <SafeAreaView style={[styles.container, safeAreaTopPad]} edges={safeAreaEdges}>
      {/* Setup Trading Modal */}
      <Modal visible={showSetupModal && !isExternalWalletUser} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            {/* Demo-mode pill — see trade/[coin].tsx for rationale. */}
            {tradingEnv === 'demo' && (
              <View style={styles.demoSetupPill}>
                <Ionicons name="flask" size={12} color={colors.accent.gold} />
                <Text style={styles.demoSetupPillText}>{t('trading.demoModePillLabel')}</Text>
              </View>
            )}
            <Text style={styles.modalTitle}>{t('trading.enableOneTapTrading', 'Activate seamless trading')}</Text>
            <Text style={styles.modalText}>
              {t(
                'trading.enableOneTapTradingDescriptionV2',
                'Approve this free one-time setup to enable unified balances, one-tap orders, and builder-fee trading.',
              )}
            </Text>
            {!!setupError && <Text style={styles.modalError}>{setupError}</Text>}
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.modalPrimary} onPress={handleSetupTrading} disabled={setupLoading}>
                {setupLoading ? (
                  <ActivityIndicator color={colors.background.primary} />
                ) : (
                  <Text style={styles.modalPrimaryText}>{t('trading.activateSeamlessTradingButton', 'Activate')}</Text>
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
              {posTpslModal ? formatDisplaySymbol(posTpslModal.coin) : ''}
            </Text>

            {posTpslModal ? (
              <View>
                <View style={styles.modalRow}>
                  <Text style={styles.modalLabel}>{t('portfolio.entry')}</Text>
                  <Text style={styles.modalValue}>{formatPriceNum(posTpslModal.entryPx)}</Text>
                </View>
                <View style={styles.modalRow}>
                  <Text style={styles.modalLabel}>{t('portfolio.mark')}</Text>
                  <Text style={styles.modalValue}>{formatPriceNum(posTpslModal.markPx)}</Text>
                </View>
                <View style={styles.modalRow}>
                  <Text style={styles.modalLabel}>{t('trading.positionSize')}</Text>
                  <Text style={styles.modalValue}>{formatAssetUnits(posTpslModal.sizeUnits)} {t('trading.units')}</Text>
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
                    <Text style={styles.inputLabel}>{t('trading.tpTriggerPrice')}</Text>
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
                    <Text style={styles.inputLabel}>{t('trading.slTriggerPrice')}</Text>
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
                      disabled={posTpslLoading}
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

                    const { agentPrivateKey } = await ensureAgentKey();
                    // HL has no "modify TP/SL" — cancel existing
                    // triggers of the matching type before placing
                    // new ones, otherwise editing leaves duplicates
                    // attached to the position.
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
                          // Tolerate stale oids — order may have already filled / been cancelled.
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
                    showToast(e?.message ? String(e.message) : t('errors.failedToSetTpsl'));
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
              <Text style={styles.modalTitle}>{t('tradeHistory.sharePnl')}</Text>
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
                <Text style={styles.pnlShareButtonText}>{t('tradeHistory.share')}</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={handleBack} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color={colors.text.primary} />
        </TouchableOpacity>
        <TouchableOpacity 
          style={styles.headerCenter} 
          onPress={handleSearchToggle}
          activeOpacity={0.7}
        >
          <AssetLogo symbol={asset.symbol} size={36} />
          <View style={styles.headerTitle}>
            <View style={styles.headerSymbolRow}>
            <Text style={styles.symbol}>{asset.symbol}</Text>
              <Ionicons name="chevron-down" size={16} color={colors.text.tertiary} style={styles.headerChevron} />
              <View style={{ position: 'relative', marginLeft: 4, overflow: 'visible' }}>
                {assetObStep === 1 && (
                  <Animated.View
                    style={[styles.obPulseRing, { top: -4, left: -4, right: -4, bottom: -4, borderRadius: 12, transform: [{ scale: assetObScale }], opacity: assetObOpacity }]}
                    pointerEvents="none"
                  />
                )}
                {isSpotModePage ? (
                  // Spot-mode (isSpotOnly or `?market=spot`) — the leverage
                  // badge is meaningless for spot, so reuse the same SPOT
                  // pill treatment already used for spot-only assets.
                  <View style={[styles.leverageBadge, { backgroundColor: 'rgba(59, 130, 246, 0.15)', borderColor: '#3B82F6' }]}>
                    <Text style={[styles.leverageText, { color: '#3B82F6' }]} allowFontScaling={false}>SPOT</Text>
                  </View>
                ) : isUltraLeverage ? (
                  <LinearGradient
                    colors={[colors.accent.gold, colors.accent.purple]}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 0 }}
                    style={[styles.leverageBadge, styles.leverageBadgeUltra]}
                  >
                    <Text style={[styles.leverageText, styles.leverageTextUltra]} allowFontScaling={false}>{asset.maxLeverage}x</Text>
                    {showLeverageFlash && <Ionicons name="flash" size={9} color={colors.background.primary} />}
                  </LinearGradient>
                ) : (
                  <View style={[styles.leverageBadge, { backgroundColor: `${leverageColor}20`, borderColor: leverageColor }]}>
                    <Text style={[styles.leverageText, { color: leverageColor }]} allowFontScaling={false}>{asset.maxLeverage}x</Text>
                    {showLeverageFlash && <Ionicons name="flash" size={9} color={leverageColor} />}
                  </View>
                )}
              </View>
              {showPreIpoBadge ? (
                <TouchableOpacity
                  style={styles.preIpoBadge}
                  onPress={() => setShowPreIpoModal(true)}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={t('trading.preIpoTitle')}
                >
                  <Ionicons name="alert-circle-outline" size={12} color={colors.accent.gold} />
                  <Text style={styles.preIpoBadgeText} allowFontScaling={false}>
                    {t('trading.preIpoBadge')}
                  </Text>
                </TouchableOpacity>
              ) : null}
            </View>
            <Text style={styles.name} numberOfLines={1}>{asset.name}</Text>
          </View>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.alertButton}
          onPress={() => {
            if (!isAuthenticated) {
              pushRouteOnce(router, '/login');
              return;
            }
            pushRouteOnce(router, {
              pathname: '/price-alerts',
              params: { coin: decodedCoin, create: '1' },
            });
          }}
        >
          <Ionicons name="notifications-outline" size={22} color={colors.text.secondary} />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.favoriteButton}
          onPress={async () => {
            if (!isAuthenticated) {
              router.push('/login');
              return;
            }
            const next = await toggleFavorite(userAddress, decodedCoin);
            setIsFavorite(next.isFavorite);
          }}
        >
          <Ionicons name={isFavorite ? 'star' : 'star-outline'} size={24} color={isFavorite ? colors.accent.gold : colors.text.secondary} />
        </TouchableOpacity>
      </View>

      {assetObStep === 1 && (
        <View style={styles.obTooltip}>
          <View style={styles.obTooltipContent}>
            <Text style={styles.obTooltipTitle}>{t('onboarding.leverageStep')}</Text>
            <Text style={styles.obTooltipDesc}>{t('onboarding.leverageDesc')}</Text>
          </View>
          <View style={styles.obTooltipFooter}>
            <View style={styles.obDots}>
              <View style={[styles.obDot, styles.obDotActive]} />
              <View style={styles.obDot} />
            </View>
            <View style={styles.obActions}>
              <TouchableOpacity onPress={handleAssetObDone} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Text style={styles.obSkipText}>{t('common.skip') ?? 'Skip'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.obActionBtn} onPress={handleAssetObNext} activeOpacity={0.85}>
                <LinearGradient
                  colors={[colors.accent.gold, colors.accent.purple]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 0 }}
                  style={styles.obActionGradient}
                >
                  <Text style={styles.obActionText}>{t('onboarding.next')}</Text>
                  <Ionicons name="arrow-forward" size={14} color={colors.background.primary} />
                </LinearGradient>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}

      <KeyboardAwareScrollView
        ref={assetScrollRef as any}
        style={styles.content}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 74 + Math.max(0, insets.bottom) }}
        scrollEnabled={!isChartInteracting}
        bottomOffset={20}
      >
        {/* Price Section */}
        <View style={[styles.priceSection, assetObStep > 0 && { opacity: 0.3 }]}>
          <View style={styles.priceRow}>
            {/* Fixed flex slot so digit-width changes while the price lerps don't nudge the badges. */}
            <View style={styles.priceSlot}>
              <LivePriceDisplay targetPrice={livePrice ?? undefined} fallbackPrice={asset.markPx} />
            </View>
            <View style={styles.priceRowRight}>
              {(asset.category === 'stock' || asset.category === 'crypto' || asset.category === 'commodity' || asset.category === 'forex' || asset.category === 'index') && (
                <TouchableOpacity
                  style={styles.geminiBadge}
                  onPress={() => {
                    if (Platform.OS !== 'web') {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                    }
                    if (!isAuthenticated) {
                      router.push('/login');
                      return;
                    }
                    Analytics.logViewAiAnalysis(asset.symbol, asset.category || 'unknown');
                    setShowStockInfoModal(true);
                  }}
                  activeOpacity={0.8}
                >
                  <View style={styles.geminiLogoContainer}>
                    <Animated.View style={[styles.geminiStar, styles.geminiStar1, { opacity: star1Opacity }]}>
                      <Ionicons name="sparkles" size={5} color={colors.accent.gold} />
                    </Animated.View>
                    <Animated.View style={[styles.geminiStar, styles.geminiStar2, { opacity: star2Opacity }]}>
                      <Ionicons name="sparkles" size={4} color={colors.accent.blue} />
                    </Animated.View>
                    <Animated.View style={[styles.geminiStar, styles.geminiStar3, { opacity: star3Opacity }]}>
                      <Ionicons name="sparkles" size={5} color={colors.accent.purple} />
                    </Animated.View>
                    <Image
                      source={require('../../assets/images/gemini-logo.webp')}
                      style={styles.geminiLogo}
                      resizeMode="contain"
                    />
                  </View>
                  <Text style={styles.geminiBadgeText} allowFontScaling={false}>{t('trading.askAi')}</Text>
                </TouchableOpacity>
              )}
              {hasAssetMeta && (
                <TouchableOpacity
                  style={styles.cryptoInfoBadge}
                  onPress={() => {
                    setShowFullDesc(false);
                    setCryptoInfoDescNeedsShowMore(false);
                    setShowCryptoInfoModal(true);
                  }}
                  activeOpacity={0.7}
                >
                  <Ionicons name="information-circle-outline" size={14} color={colors.accent.blue} />
                  <Text style={styles.cryptoInfoBadgeText}>{t('trading.cryptoInfo')}</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>

          <View style={styles.subPriceRow}>
            <Text style={[styles.priceChange, { color: changeColor }]}>
              {formatChange(asset.change24h)}
            </Text>
            <View style={styles.miniStatsRow}>
              <View style={styles.miniStat}>
                <Text style={styles.miniStatLabel}>{t('trading.compactStatLabels.volume24h')}</Text>
                <Text style={styles.miniStatValue} numberOfLines={1}>{formatVolume(effectiveVolume)}</Text>
              </View>
              {!isSpotModePage && (
                <>
                  <View style={styles.miniStatSep} />
                  <TouchableOpacity style={styles.miniStat} onPress={() => setShowOpenInterestModal(true)} activeOpacity={0.6}>
                    <DashedUnderline text={t('trading.compactStatLabels.openInterest')} textStyle={styles.miniStatLabel} containerStyle={{ alignSelf: 'center' }} />
                    <Text style={styles.miniStatValue} numberOfLines={1}>{openInterestUsd !== null ? formatVolume(String(openInterestUsd)) : '--'}</Text>
                  </TouchableOpacity>
                  <View style={styles.miniStatSep} />
                  <TouchableOpacity style={styles.miniStat} onPress={() => setShowFundingModal(true)} activeOpacity={0.6}>
                    <DashedUnderline text={t('trading.compactStatLabels.fundingRate')} textStyle={styles.miniStatLabel} containerStyle={{ alignSelf: 'center' }} />
                    <Text style={styles.miniStatValue} numberOfLines={1}>{formatFunding(effectiveFunding)}</Text>
                  </TouchableOpacity>
                  {/* Oracle stat — uncomment to restore
                  <View style={styles.miniStatSep} />
                  <TouchableOpacity style={styles.miniStat} onPress={() => setShowOracleModal(true)} activeOpacity={0.6}>
                    <DashedUnderline text={t('trading.compactStatLabels.oraclePrice')} textStyle={styles.miniStatLabel} containerStyle={{ alignSelf: 'center' }} />
                    <Text style={styles.miniStatValue} numberOfLines={1}>{formatPrice(effectiveOraclePx)}</Text>
                  </TouchableOpacity>
                  */}
                </>
              )}
            </View>
          </View>
        </View>

        <View style={assetObStep > 0 ? { opacity: 0.3 } : undefined}>
        <AssetChart
          decodedCoin={chartDecodedCoin}
          assetSymbol={asset.symbol}
          isAuthenticated={isAuthenticated}
          userAddress={
            embeddedAddress && embeddedAddress.startsWith('0x')
              ? embeddedAddress
              : userAddress && userAddress.startsWith('0x')
                ? userAddress
                : null
          }
          tradingAddress={
            tradingAddress && tradingAddress.startsWith('0x') ? tradingAddress : null
          }
          positions={filteredPositions}
          openOrders={filteredOpenOrders}
          userFills={filteredFills}
          livePrice={livePrice}
          chartId="asset"
          onInteractionChange={setIsChartInteracting}
          spotPositions={spotPositionsForChart.length > 0 ? spotPositionsForChart : undefined}
        />
        </View>

        {/* Trade Button (Split: main + quick trade lightning) */}
        <View style={styles.tradeButtonContainer}>
          <TouchableOpacity style={styles.tradeButtonMain} onPress={handleTrade}>
            <Ionicons name="swap-horizontal" size={20} color={colors.background.primary} />
            <Text style={styles.tradeButtonText}>{t('trading.tradeSymbol', { symbol: asset.symbol })}</Text>
          </TouchableOpacity>
          <View style={{ position: 'relative', overflow: 'visible' }}>
            {assetObStep === 2 && (
              <Animated.View
                style={[styles.obPulseRing, { top: -4, left: -4, right: -4, bottom: -4, borderRadius: 16, transform: [{ scale: assetObScale }], opacity: assetObOpacity }]}
                pointerEvents="none"
              />
            )}
            <LinearGradient
              colors={[colors.accent.gold, colors.accent.purple]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.tradeButtonQuick}
            >
              <TouchableOpacity 
                onPress={handleQuickTradeToggle} 
                activeOpacity={0.8}
                style={styles.tradeButtonQuickInner}
              >
                <Ionicons name="flash" size={20} color={colors.background.primary} />
              </TouchableOpacity>
            </LinearGradient>
          </View>
        </View>

        {assetObStep === 2 && (
          <View style={styles.obTooltip}>
            <View style={styles.obTooltipContent}>
              <Text style={styles.obTooltipTitle}>{t('onboarding.quickTradeStep')}</Text>
              <Text style={styles.obTooltipDesc}>{t('onboarding.quickTradeDesc')}</Text>
            </View>
            <View style={styles.obTooltipFooter}>
              <View style={styles.obDots}>
                <View style={styles.obDot} />
                <View style={[styles.obDot, styles.obDotActive]} />
              </View>
              <TouchableOpacity style={styles.obActionBtn} onPress={handleAssetObDone} activeOpacity={0.85}>
                <LinearGradient
                  colors={[colors.accent.gold, colors.accent.purple]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 0 }}
                  style={styles.obActionGradient}
                >
                  <Text style={styles.obActionText}>{t('onboarding.gotIt')}</Text>
                  <Ionicons name="checkmark" size={14} color={colors.background.primary} />
                </LinearGradient>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Portfolio Tabs - Positions, Orders, History */}
        {isAuthenticated && (
          <View style={assetObStep > 0 ? { opacity: 0.3 } : undefined}>
          <View style={styles.sectionDivider}>
            <View style={styles.sectionDividerLine} />
            <Text style={styles.sectionDividerText}>{t('portfolio.tradingActivity')}</Text>
            <View style={styles.sectionDividerLine} />
          </View>
          <TradingBookSwitcher variant="chips" />
          <PortfolioTabsWithLivePrices
            liveCoins={liveCoins}
            portfolioTab={portfolioTab}
            onTabChange={setPortfolioTab}
            isInitialPortfolioLoading={!tradingStateReady}
            pendingSkeletonRowCount={portfolioTabsPendingRefresh ? 1 : 0}
            positions={filteredPositions}
            openOrders={filteredOpenOrders}
            fills={filteredFills}
            hip3Prices={hip3Prices}
            fundingRates={fundingRates}
            fundingAccrued={fundingAccrued}
            activeAssetData={activeAssetData}
            spotBalances={combinedSpotBalances}
            currentAssetSymbol={asset?.coin ?? asset?.symbol}
            currentAssetMarkPx={livePrice != null ? String(livePrice) : asset?.markPx}
            assetRouteCoin={asset?.coin ?? decodedCoin}
            assetRouteIsSpot={isSpotModePage}
            navigationMode="replace"
            marginMode="isolated"
            showMarginMode
            closingPositionKey={closingPositionKey}
            cancelingOrderId={cancelingOrderId}
            isSubmitting={false}
            pnlShareLoading={pnlShareLoading}
            isCloseAllLoading={closeAllLoading}
            isCancelAllLoading={cancelAllLoading}
            onClosePosition={handleMarketClose}
            onCancelOrder={handleCancelOrder}
            onModifyOrder={handleModifyOrder}
            onCloseAllPositions={handleCloseAllPositions}
            onCancelAllOrders={handleCancelAllOrders}
            onOpenTpsl={(payload) => {
              setPosTpEnabled(false);
              setPosSlEnabled(false);
              setPosTpPxText('');
              setPosSlPxText('');
              setPosTpslModal(payload);
            }}
            onSharePositionPnl={(payload) => setPnlShareModal(payload)}
            onShareFillPnl={(payload) => setPnlShareModal(payload)}
            formatPrice={formatPrice}
            formatPriceNum={formatPriceNum}
            formatSignedUsd={formatSignedUsd}
            safeNum={safeNum}
            formatShortTime={formatShortTime}
            aiScopeAgentId={activeTradingBook.agentId}
          />
          </View>
        )}

        {/* Dev: replay asset onboarding tour
        {isAuthenticated && assetObStep === 0 && (
          <TouchableOpacity onPress={handleResetAssetOnboarding} style={styles.obResetBtn} activeOpacity={0.6}>
            <Ionicons name="refresh-outline" size={13} color={colors.text.tertiary} />
            <Text style={styles.obResetText}>Replay tour</Text>
          </TouchableOpacity>
        )}*/}
      </KeyboardAwareScrollView>

      {/* Funding Rate Modal */}
      <Modal
        visible={showFundingModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowFundingModal(false)}
      >
        <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setShowFundingModal(false)}>
          <TouchableOpacity style={styles.modalCard} activeOpacity={1}>
            <Text style={styles.modalTitle}>{t('trading.fundingRate')}</Text>
            <Text style={styles.modalText}>
              {t('trading.fundingRateDescription')}
            </Text>
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.modalPrimary} onPress={() => setShowFundingModal(false)}>
                <Text style={styles.modalPrimaryText}>{t('common.gotIt')}</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Open Interest Modal */}
      <Modal
        visible={showOpenInterestModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowOpenInterestModal(false)}
      >
        <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setShowOpenInterestModal(false)}>
          <TouchableOpacity style={styles.modalCard} activeOpacity={1}>
            <Text style={styles.modalTitle}>{t('trading.openInterest')}</Text>
            <Text style={styles.modalText}>
              {t('trading.openInterestDescription')}
            </Text>
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.modalPrimary} onPress={() => setShowOpenInterestModal(false)}>
                <Text style={styles.modalPrimaryText}>{t('common.gotIt')}</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Oracle Price Modal */}
      <Modal
        visible={showOracleModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowOracleModal(false)}
      >
        <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setShowOracleModal(false)}>
          <TouchableOpacity style={styles.modalCard} activeOpacity={1}>
            <Text style={styles.modalTitle}>{t('trading.oraclePrice')}</Text>
            <Text style={styles.modalText}>
              {t('trading.oraclePriceDescription')}
            </Text>
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.modalPrimary} onPress={() => setShowOracleModal(false)}>
                <Text style={styles.modalPrimaryText}>{t('common.gotIt')}</Text>
              </TouchableOpacity>
          </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Pre-IPO (IPOP) Modal */}
      <Modal
        visible={showPreIpoModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowPreIpoModal(false)}
      >
        <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setShowPreIpoModal(false)}>
          <TouchableOpacity style={styles.modalCard} activeOpacity={1}>
            <Text style={styles.modalTitle}>{t('trading.preIpoTitle')}</Text>
            <Text style={styles.modalText}>{t('trading.preIpoDescription')}</Text>
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.modalPrimary} onPress={() => setShowPreIpoModal(false)}>
                <Text style={styles.modalPrimaryText}>{t('common.gotIt')}</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Stock Info Modal */}
      <Modal
        visible={showStockInfoModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowStockInfoModal(false)}
      >
        <View style={styles.modalBackdrop}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setShowStockInfoModal(false)}
          />
          <View style={[styles.modalCard, styles.infoModalCardWrap]}>
            <TouchableOpacity
              style={styles.infoModalClose}
              onPress={() => setShowStockInfoModal(false)}
              activeOpacity={0.6}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              accessibilityRole="button"
              accessibilityLabel={t('common.close')}
            >
              <Ionicons name="close" size={22} color={colors.text.primary} />
            </TouchableOpacity>
            <View style={styles.infoModalHeaderContent}>
              <AssetLogo symbol={asset.symbol} size={28} />
              <View style={styles.infoModalHeaderTextBlock}>
                <Text style={styles.modalTitle}>{t('trading.marketAnalysis')}</Text>
                <Text style={styles.modalSubtitle}>{t('trading.liveData')}</Text>
              </View>
            </View>
            {showStockInfoModal && (
              <GeminiAnalysisPanel symbol={asset.symbol} category={asset.category} />
            )}
          </View>
        </View>
      </Modal>

      {/* Crypto Info Modal */}
      <Modal
        visible={showCryptoInfoModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowCryptoInfoModal(false)}
      >
        <View style={styles.modalBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setShowCryptoInfoModal(false)} />
          <View style={styles.cryptoInfoCard}>
            <TouchableOpacity
              style={styles.infoModalClose}
              onPress={() => setShowCryptoInfoModal(false)}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              accessibilityRole="button"
              accessibilityLabel={t('common.close')}
            >
              <Ionicons name="close" size={22} color={colors.text.primary} />
            </TouchableOpacity>
            <View style={styles.infoModalHeaderContent}>
              <AssetLogo symbol={asset.symbol} size={28} />
              <View style={styles.cryptoInfoHeaderTitles}>
                <Text style={styles.modalTitle}>{asset.name}</Text>
                <Text style={styles.modalSubtitle} numberOfLines={2}>
                  {isStock && stockFundamentals?.industry
                    ? `${asset.symbol} — ${stockFundamentals.industry}`
                    : !isStock && cryptoMeta?.category
                      ? `${asset.symbol} — ${cryptoMeta.category}`
                      : asset.symbol}
                </Text>
              </View>
            </View>
            <ScrollView style={{ maxHeight: 420 }} showsVerticalScrollIndicator>

            {cryptoInfoModalDescription ? (
              <View>
                {showCryptoInfoModal && !showFullDesc ? (
                  <Text
                    accessible={false}
                    pointerEvents="none"
                    style={[styles.cryptoInfoDesc, styles.cryptoInfoDescMeasure]}
                    onTextLayout={(e) => {
                      setCryptoInfoDescNeedsShowMore(e.nativeEvent.lines.length > 3);
                    }}
                  >
                    {cryptoInfoModalDescription}
                  </Text>
                ) : null}
                <Text style={styles.cryptoInfoDesc} numberOfLines={showFullDesc ? undefined : 3}>
                  {cryptoInfoModalDescription}
                </Text>
                {cryptoInfoDescNeedsShowMore && !showFullDesc ? (
                  <TouchableOpacity onPress={() => setShowFullDesc(true)} activeOpacity={0.7}>
                    <Text style={styles.readMoreText}>{t('home.showMore')}</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            ) : null}

            {isStock ? (
              <>
                <View style={styles.cryptoInfoGrid}>
                  <View style={styles.cryptoInfoRow}>
                    <Text style={styles.cryptoInfoLabel}>{t('trading.nextEarnings')}</Text>
                    <Text style={styles.cryptoInfoValue}>
                      {formatNextEarningsInfoValue(
                        asset.nextEarnings,
                        i18n.language,
                        t('trading.nextEarningsTBA'),
                      )}
                    </Text>
                  </View>
                  <View style={styles.cryptoInfoRow}>
                    <Text style={styles.cryptoInfoLabel}>{t('trading.sharesOutstanding')}</Text>
                    <Text style={styles.cryptoInfoValue}>
                      {stockFundamentals?.outstanding_shares
                        ? Number(stockFundamentals.outstanding_shares).toLocaleString('en-US')
                        : t('trading.nextEarningsTBA')}
                    </Text>
                  </View>
                  <View style={styles.cryptoInfoRow}>
                    <Text style={styles.cryptoInfoLabel}>{t('trading.marketCap')}</Text>
                    <Text style={styles.cryptoInfoValue}>
                      {formatStockFundamentalValue(
                        liveStockMktCap,
                        (v) => (isKrwListedStock ? fmtKrw(v) : fmtDollar(v)),
                        t('trading.nextEarningsTBA'),
                      )}
                    </Text>
                  </View>
                  <View style={styles.cryptoInfoRow}>
                    <Text style={styles.cryptoInfoLabel}>{t('trading.peRatio')}</Text>
                    <Text style={styles.cryptoInfoValue}>
                      {formatStockFundamentalValue(
                        stockFundamentals?.pe_ratio,
                        (v) => v.toFixed(2),
                        t('trading.nextEarningsTBA'),
                      )}
                    </Text>
                  </View>
                  <View style={styles.cryptoInfoRow}>
                    <Text style={styles.cryptoInfoLabel}>{t('trading.eps')}</Text>
                    <Text style={styles.cryptoInfoValue}>
                      {formatStockFundamentalValue(
                        stockFundamentals?.eps,
                        (v) => (isKrwListedStock ? fmtKrw(v, 2) : `$${v.toFixed(2)}`),
                        t('trading.nextEarningsTBA'),
                      )}
                    </Text>
                  </View>
                  <View style={styles.cryptoInfoRow}>
                    <Text style={styles.cryptoInfoLabel}>{t('trading.week52High')}</Text>
                    <Text style={styles.cryptoInfoValue}>
                      {formatStockFundamentalValue(
                        stockFundamentals?.week52_high,
                        (v) => (isKrwListedStock ? fmtKrw(v, 2) : `$${v.toFixed(2)}`),
                        t('trading.nextEarningsTBA'),
                      )}
                    </Text>
                  </View>
                  <View style={styles.cryptoInfoRow}>
                    <Text style={styles.cryptoInfoLabel}>{t('trading.week52Low')}</Text>
                    <Text style={styles.cryptoInfoValue}>
                      {formatStockFundamentalValue(
                        stockFundamentals?.week52_low,
                        (v) => (isKrwListedStock ? fmtKrw(v, 2) : `$${v.toFixed(2)}`),
                        t('trading.nextEarningsTBA'),
                      )}
                    </Text>
                  </View>
                  <View style={styles.cryptoInfoRow}>
                    <Text style={styles.cryptoInfoLabel}>{t('trading.ttmRevenue')}</Text>
                    <Text style={styles.cryptoInfoValue}>
                      {formatStockFundamentalValue(
                        stockFundamentals?.revenue,
                        (v) => (isKrwListedStock ? fmtKrw(v) : fmtDollar(v)),
                        t('trading.nextEarningsTBA'),
                      )}
                    </Text>
                  </View>
                  <View style={styles.cryptoInfoRow}>
                    <Text style={styles.cryptoInfoLabel}>{t('trading.netIncome')}</Text>
                    <Text style={styles.cryptoInfoValue}>
                      {formatStockFundamentalValue(
                        stockFundamentals?.net_income,
                        (v) => (isKrwListedStock ? fmtKrw(v) : fmtDollar(v)),
                        t('trading.nextEarningsTBA'),
                      )}
                    </Text>
                  </View>
                  <View style={styles.cryptoInfoRow}>
                    <Text style={styles.cryptoInfoLabel}>{t('trading.grossProfit')}</Text>
                    <Text style={styles.cryptoInfoValue}>
                      {formatStockFundamentalValue(
                        stockFundamentals?.gross_profit,
                        (v) => (isKrwListedStock ? fmtKrw(v) : fmtDollar(v)),
                        t('trading.nextEarningsTBA'),
                      )}
                    </Text>
                  </View>
                  <View style={styles.cryptoInfoRow}>
                    <Text style={styles.cryptoInfoLabel}>{t('trading.operatingIncome')}</Text>
                    <Text style={styles.cryptoInfoValue}>
                      {formatStockFundamentalValue(
                        stockFundamentals?.operating_income,
                        (v) => (isKrwListedStock ? fmtKrw(v) : fmtDollar(v)),
                        t('trading.nextEarningsTBA'),
                      )}
                    </Text>
                  </View>
                  <View style={styles.cryptoInfoRow}>
                    <Text style={styles.cryptoInfoLabel}>{t('trading.ebitda')}</Text>
                    <Text style={styles.cryptoInfoValue}>
                      {formatStockFundamentalValue(
                        stockFundamentals?.ebitda,
                        (v) => (isKrwListedStock ? fmtKrw(v) : fmtDollar(v)),
                        t('trading.nextEarningsTBA'),
                      )}
                    </Text>
                  </View>
                  <View style={styles.cryptoInfoRow}>
                    <Text style={styles.cryptoInfoLabel}>{t('trading.profitMargin')}</Text>
                    <Text style={styles.cryptoInfoValue}>
                      {formatStockFundamentalValue(
                        stockFundamentals?.profit_margin,
                        (v) => `${v.toFixed(1)}%`,
                        t('trading.nextEarningsTBA'),
                      )}
                    </Text>
                  </View>
                  <View style={styles.cryptoInfoRow}>
                    <Text style={styles.cryptoInfoLabel}>{t('trading.freeCashFlow')}</Text>
                    <Text style={styles.cryptoInfoValue}>
                      {formatStockFundamentalValue(
                        stockFundamentals?.free_cash_flow,
                        (v) => (isKrwListedStock ? fmtKrw(v) : fmtDollar(v)),
                        t('trading.nextEarningsTBA'),
                      )}
                    </Text>
                  </View>
                </View>
              </>
            ) : (
              <>
                {(isCrypto || cryptoMeta?.circulating_supply || cryptoMeta?.max_supply) ? (
                  <View style={styles.cryptoInfoGrid}>
                    <View style={styles.cryptoInfoRow}>
                      <Text style={styles.cryptoInfoLabel}>{t('trading.circulatingSupply')}</Text>
                      <Text style={styles.cryptoInfoValue}>
                        {cryptoMeta?.circulating_supply
                          ? Number(cryptoMeta.circulating_supply).toLocaleString('en-US')
                          : '--'}
                      </Text>
                    </View>
                    <View style={styles.cryptoInfoRow}>
                      <Text style={styles.cryptoInfoLabel}>{t('trading.maxSupply')}</Text>
                      <Text style={styles.cryptoInfoValue}>
                        {cryptoMeta?.max_supply
                          ? Number(cryptoMeta.max_supply).toLocaleString('en-US')
                          : '∞'}
                      </Text>
                    </View>
                    <View style={styles.cryptoInfoRow}>
                      <Text style={styles.cryptoInfoLabel}>{t('trading.marketCap')}</Text>
                      <Text style={styles.cryptoInfoValue}>
                        {(() => {
                          const circ = cryptoMeta?.circulating_supply;
                          const px = livePrice ?? (asset.markPx ? parseFloat(asset.markPx) : NaN);
                          if (!circ || !Number.isFinite(px)) return '--';
                          return fmtDollar(circ * px);
                        })()}
                      </Text>
                    </View>
                  </View>
                ) : null}

                {cryptoMeta?.whitepaper_url ? (
                  <TouchableOpacity
                    style={styles.cryptoInfoWhitepaper}
                    onPress={() => {
                      if (cryptoMeta?.whitepaper_url) void openHttpsUrl(cryptoMeta.whitepaper_url);
                    }}
                    activeOpacity={0.7}
                  >
                    <Ionicons name="document-text-outline" size={16} color={colors.accent.gold} />
                    <Text style={styles.cryptoInfoWhitepaperText}>{t('trading.viewWhitepaper')}</Text>
                    <Ionicons name="open-outline" size={14} color={colors.accent.gold} />
                  </TouchableOpacity>
                ) : null}
              </>
            )}

            {infoModalXSearchSymbol ? (
              <TouchableOpacity
                style={[
                  styles.cryptoInfoXSearchOuter,
                  cryptoMeta?.whitepaper_url && !isStock ? styles.cryptoInfoXSearchBelowWhitepaper : null,
                ]}
                onPress={() => {
                  void openHttpsUrl(buildXCashtagSearchUrl(infoModalXSearchSymbol));
                }}
                activeOpacity={0.7}
                accessibilityRole="link"
                accessibilityLabel={t('trading.searchSymbolOnX', { symbol: infoModalXCashtag })}
              >
                <LinearGradient
                  colors={['#1a1a2e', '#16213e', '#0f0f1a']}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={[styles.cryptoInfoWhitepaper, styles.cryptoInfoXSearch]}
                >
                  <Image
                    source={require('../../assets/images/x-logo-white.webp')}
                    style={styles.cryptoInfoXLogo}
                    resizeMode="contain"
                  />
                  <Text style={styles.cryptoInfoXSearchText}>
                    {t('trading.searchSymbolOnX', { symbol: infoModalXCashtag })}
                  </Text>
                  <Ionicons name="open-outline" size={14} color={colors.text.primary} />
                </LinearGradient>
              </TouchableOpacity>
            ) : null}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Search Modal */}
      <Modal 
        visible={showSearch} 
        animationType="fade" 
        transparent
        statusBarTranslucent
        onShow={() => {
          // Android needs statusBarTranslucent + a delay; autoFocus is removed below
          // because it conflicts with manual focus() inside Modal on Android.
          const focusInput = () => searchInputRef.current?.focus();
          setTimeout(focusInput, 80);
          setTimeout(focusInput, 250);
        }}
      >
        <Pressable style={styles.searchModalBackdrop} onPress={handleSearchClose}>
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={styles.searchModalContainer}
          >
            <Pressable onPress={() => {}} onStartShouldSetResponder={() => true}>
              <View style={styles.searchInputWrapper}>
                <Ionicons name="search" size={18} color={colors.text.tertiary} />
                <TextInput
                  ref={searchInputRef}
                  style={styles.searchInput}
                  placeholder={t('header.searchPlaceholder')}
                  placeholderTextColor={colors.text.tertiary}
                  value={searchText}
                  onChangeText={setSearchText}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  returnKeyType="search"
                />
                {searchText.length > 0 && (
                  <TouchableOpacity onPress={() => setSearchText('')}>
                    <Ionicons name="close-circle" size={18} color={colors.text.tertiary} />
                  </TouchableOpacity>
                )}
              </View>

              <FlatList
                data={searchResults}
                keyExtractor={(item) => item.searchRowKey}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={styles.searchResultsContainer}
                extraData={searchPricesTick}
                renderItem={({ item }) => {
                  const row = item as AssetSearchRow;
                  const searchPrices = pricesRef.current;
                  const spotSym = row.spotSymbol ? String(row.spotSymbol) : null;
                  const livePrice =
                    row.searchMarket === 'spot' && spotSym
                      ? pickPrice(searchPrices, { coin: spotSym })
                      : pickPrice(searchPrices, {
                          coin: row.coin,
                          symbol: row.symbol,
                          isHip3: row.isHip3 === true,
                        });
                  const displayPrice =
                    livePrice ||
                    (row.searchMarket === 'spot' && !row.isSpotOnly
                      ? undefined
                      : row.markPx ?? (row as any).oraclePx);
                  const change24h =
                    row.searchMarket === 'spot' && !row.isSpotOnly
                      ? null
                      : row.change24h ?? null;
                  const isFavorite = favoriteSet.has(row.coin);
                  const changeColor =
                    change24h === null || change24h === 0
                      ? colors.text.secondary
                      : change24h >= 0
                        ? colors.status.success
                        : colors.status.error;

                  return (
                    <TouchableOpacity style={styles.searchResultItem} onPress={() => handleSearchSelect(row)}>
                      {isAuthenticated && (
                        <TouchableOpacity
                          onPress={(e) => handleSearchFavoriteToggle(row, e)}
                          style={styles.searchFavoriteButton}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        >
                          <Ionicons 
                            name={isFavorite ? 'star' : 'star-outline'} 
                            size={18} 
                            color={isFavorite ? colors.accent.gold : colors.text.tertiary} 
                          />
                        </TouchableOpacity>
                      )}
                      <View style={styles.searchResultContent}>
                        <View style={styles.searchResultRow}>
                          <View style={styles.searchResultLeft}>
                            <View style={styles.searchResultTickerRow}>
                              <Text style={styles.searchResultTicker} allowFontScaling={false}>
                                {formatDisplaySymbol(row.symbol || row.coin)}
                              </Text>
                              {row.searchMarket === 'spot' && (
                                <View style={styles.searchResultBadge}>
                                  <Text style={styles.searchResultBadgeText}>{t('home.spot')}</Text>
                                </View>
                              )}
                            </View>
                            <Text style={styles.searchResultName} numberOfLines={1}>{row.name}</Text>
                          </View>
                          <View style={styles.searchResultPriceColumn}>
                            <Text style={styles.searchResultPrice}>{formatSearchPrice(displayPrice)}</Text>
                            {change24h !== null && (
                              <Text style={[styles.searchResultChange, { color: changeColor }]}>
                                {formatSearchChange(change24h)}
                              </Text>
                            )}
                          </View>
                          <View style={styles.searchResultCategoryContainer}>
                            <Text style={styles.searchResultCategory} numberOfLines={1}>
                              {row.category === 'forex' ? 'Forex' : row.category === 'commodity' ? 'Commodity' : row.category === 'stock' ? 'Stock' : 'Crypto'}
                            </Text>
                          </View>
                        </View>
                      </View>
                    </TouchableOpacity>
                  );
                }}
                ListEmptyComponent={
                  <View style={styles.searchEmpty}>
                    <Text style={styles.searchEmptyText}>
                      {debouncedSearch.length > 0 ? t('common.noResults') : t('home.startTyping')}
                    </Text>
                    <TouchableOpacity onPress={handleSearchClose} style={styles.searchEmptyClose}>
                      <Text style={styles.searchEmptyCloseText}>{t('common.close')}</Text>
                    </TouchableOpacity>
                  </View>
                }
              />
            </Pressable>
          </KeyboardAvoidingView>
        </Pressable>
      </Modal>

      {/* Quick Trade Bottom Sheet */}
      {showQuickTrade && (
        <Animated.View 
          style={[
            styles.bottomSheetOverlay,
            {
              opacity: opacityAnim,
            },
          ]}
        >
          <Pressable style={styles.bottomSheetBackdrop} onPress={closeQuickTrade} />
          <Animated.View
            style={[
              styles.bottomSheetContainer,
              {
                transform: [{ translateY: Animated.add(slideAnim, keyboardOffset) }],
              },
            ]}
          >
            {/* Glow temporarily disabled
            <View style={styles.bottomSheetGlow} pointerEvents="none">
              <QuickTradeDrawerGlow />
            </View>
            */}
            <View {...panResponder.panHandlers} style={styles.bottomSheetHandleArea}>
              <View style={styles.bottomSheetHandle} />
            </View>
            <QuickTradeCard
              symbol={asset?.symbol ?? ''}
              coin={asset?.coin ?? ''}
              markPx={asset?.markPx ?? '0'}
              oraclePx={asset?.oraclePx ?? undefined}
              maxLeverage={asset?.maxLeverage ?? 20}
              isHip3={asset?.isHip3}
              growthMode={asset?.growthMode}
              deployerFeeScale={asset?.deployerFeeScale}
              // Force spot-only mode when the user landed on the page from the
              // Spot tab or a spot position row. `isSpotOnly` is what
              // QuickTradeCard already reads to lock the market toggle, so
              // spot-mode pages reuse that same gate; a perp-mode page keeps
              // the existing behavior unchanged.
              isSpotOnly={isSpotModePage}
              hasSpot={asset?.hasSpot === true}
              spotSymbol={asset?.spotSymbol}
              embeddedAddress={embeddedAddress}
              getUserWalletProvider={embeddedWallet ? getUserWalletProvider : undefined}
              crossAccountValueUsd={(() => {
                // Pick the cross-only equity for THIS asset's dex. HL keeps
                // each dex's cross pool independent, so a HIP-3 dex's
                // equity must NOT back a main-dex position and vice versa.
                // HIP-3 coins are encoded as 'dexName:SYMBOL'; main-dex
                // coins use key ''.
                const coin = String(asset?.coin ?? '');
                const dexKey = coin.includes(':') ? coin.split(':')[0] : '';
                let adjusted = effectiveTradingState?.perpCrossAccountValueByDex?.[dexKey] ?? 0;
                const positions = (effectiveTradingState?.positions ?? []) as any[];
                positions.forEach((p) => {
                  if (p?.marginType !== 'cross') return;
                  const posCoin = String(p?.coin ?? '');
                  const posDexKey = posCoin.includes(':') ? posCoin.split(':')[0] : '';
                  if (posDexKey !== dexKey) return;
                  const szi = safeNum(p?.szi);
                  const absSzi = Math.abs(szi);
                  if (!Number.isFinite(szi) || !Number.isFinite(absSzi) || absSzi <= 0) return;
                  const liveRaw =
                    pickPrice(pricesRef.current, { coin: posCoin, isHip3: posDexKey !== '' }) ??
                    pickPrice(hip3Prices, { coin: posCoin, isHip3: posDexKey !== '' });
                  const livePx = safeNum(liveRaw);
                  const posValue = safeNum(p?.positionValue ?? p?.position_value ?? p?.notional);
                  const streamMark = Number.isFinite(posValue) && posValue > 0 ? Math.abs(posValue) / absSzi : NaN;
                  if (!Number.isFinite(livePx) || livePx <= 0 || !Number.isFinite(streamMark) || streamMark <= 0) return;
                  adjusted += (livePx - streamMark) * szi;
                });
                return Math.max(0, adjusted);
              })()}
              crossMaintenanceMarginUsedUsd={(() => {
                // Sum of every OPEN cross position's maintenance margin in
                // the SAME dex pool. Pairs with crossAccountValueUsd to give
                // HL's shared margin_available scalar (without it, projecting
                // a NEW position on an asset where the user has no existing
                // same-asset position ignores their other cross positions'
                // maintenance margin and the projected liq is too safe).
                const coin = String(asset?.coin ?? '');
                const dexKey = coin.includes(':') ? coin.split(':')[0] : '';
                return effectiveTradingState?.perpCrossMaintenanceMarginUsedByDex?.[dexKey] ?? 0;
              })()}
              accountAbstractionMode={effectiveTradingState?.accountAbstractionMode ?? null}
              unifiedSpotUsdcBalanceUsd={effectiveTradingState?.spotUsdcBalanceUsd ?? 0}
              unifiedSpotUsdcHoldUsd={(effectiveTradingState as any)?.spotUsdcHoldUsd ?? 0}
              unifiedTotalIsolatedMarginUsedUsd={effectiveTradingState?.totalIsolatedMarginUsedUsd ?? 0}
              unifiedTotalCrossMaintenanceMarginUsedUsd={effectiveTradingState?.totalCrossMaintenanceMarginUsedUsd ?? 0}
              unifiedTotalCrossInitialMarginUsedUsd={(effectiveTradingState as any)?.totalCrossInitialMarginUsedUsd ?? 0}
              unifiedTotalCrossPositionValueUsd={(effectiveTradingState as any)?.totalCrossPositionValueUsd ?? 0}
              unifiedRestingOrdersInitMarginUsd={(effectiveTradingState as any)?.restingOrdersInitMarginUsd ?? 0}
              targetDexMarginAvailableUsd={(() => {
                const coin = String(asset?.coin ?? '');
                const dexKey = coin.includes(':') ? coin.split(':')[0] : '';
                return effectiveTradingState?.perpInitialMarginAvailableByDex?.[dexKey] ?? undefined;
              })()}
              perpWithdrawableByDex={effectiveTradingState?.perpWithdrawableByDex}
              mainDexWithdrawableUsd={effectiveTradingState?.perpWithdrawableByDex?.[''] ?? 0}
              withdrawableUsd={effectiveTradingState?.withdrawableUsd ?? 0}
              hasBalance={effectiveTradingState?.hasBalance ?? false}
              isAgentActive={effectiveTradingState?.isAgentActive ?? false}
              setupComplete={setupComplete}
              isAuthenticated={isAuthenticated}
              onAuthRequired={() => router.push('/login')}
              onSetupRequired={() =>
                isExternalWalletUser ? requestExternalSetup() : setShowSetupModal(true)
              }
              onOrderSuccess={handleQuickTradeOrderSuccess}
              onOrderSuccessAlert={showQuickTradeOrderSuccessAlert}
              existingPosition={currentPosition}
              restingOrderLock={restingOrderLockForCoin}
            />
          </Animated.View>
        </Animated.View>
      )}

      {quickTradeSuccessAlert ? (
        <FloatingTradeAlert
          variant="success"
          title={quickTradeSuccessAlert.title}
          message={quickTradeSuccessAlert.message}
          top={(topStripActive ? topPadding : insets.top) + 8}
        />
      ) : null}
    </SafeAreaView>
  );
}

type DashedUnderlineProps = {
  text: string;
  textStyle?: any;
  /** Merges with default wrapper; e.g. `{ alignSelf: 'center' }` for centered compact rows */
  containerStyle?: any;
  /** e.g. `adjustsFontSizeToFit`, `numberOfLines` for tight layouts */
  textProps?: TextProps;
};

const DashedUnderline = ({ text, textStyle, containerStyle, textProps }: DashedUnderlineProps) => {
  const [textWidth, setTextWidth] = useState(0);

  const GAP = 1.5;
  const numDashes = textWidth > 0 ? Math.max(2, Math.round(textWidth / 3.5)) : 0;
  const computedDashWidth = numDashes > 1
    ? (textWidth - GAP * (numDashes - 1)) / numDashes
    : textWidth;

  useEffect(() => {
    setTextWidth(0);
  }, [text]);

  return (
    <View style={[{ position: 'relative', alignSelf: 'flex-start' }, containerStyle]}>
      <Text
        {...textProps}
        style={textStyle}
        onTextLayout={(e) => {
          textProps?.onTextLayout?.(e);
          const line = e.nativeEvent.lines[0];
          const w = line && typeof line.width === 'number' ? line.width : 0;
          if (w > 0) setTextWidth(w);
        }}
        onLayout={(e) => {
          textProps?.onLayout?.(e);
          setTextWidth((tw) => {
            if (tw > 0) return tw;
            const flat = StyleSheet.flatten(textStyle) as { width?: string | number } | undefined;
            if (flat?.width === '100%') return tw;
            const lw = e.nativeEvent.layout.width;
            return lw > 0 ? lw : tw;
          });
        }}
      >
        {text}
      </Text>
      {numDashes > 0 && (
        <View
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            width: textWidth,
            height: 1,
            flexDirection: 'row',
            alignItems: 'center',
          }}
        >
          {Array.from({ length: numDashes }).map((_, i) => (
            <View
              key={i}
              style={{
                width: computedDashWidth,
                height: 1,
                backgroundColor: colors.text.tertiary,
                marginRight: i < numDashes - 1 ? GAP : 0,
              }}
            />
          ))}
        </View>
      )}
    </View>
  );
};

// ── 60fps Lerp-animated price display with momentum coloring ──
const LivePriceDisplay = React.memo(({ targetPrice, fallbackPrice }: { targetPrice?: number; fallbackPrice: string | null | undefined }) => {
  const { formatDisplayPrice } = useDisplayCurrency();
  const numericTarget = targetPrice ?? (fallbackPrice ? parseFloat(fallbackPrice) : NaN);

  const formatLerp = useCallback((n: number): string => {
    if (!Number.isFinite(n)) return '--';
    return formatDisplayPrice(n);
  }, [formatDisplayPrice]);

  const [display, setDisplay] = useState(() => formatLerp(numericTarget));
  const [momentumColor, setMomentumColor] = useState(colors.text.primary);

  const sRef = useRef({
    lerp: Number.isFinite(numericTarget) ? numericTarget : 0,
    target: Number.isFinite(numericTarget) ? numericTarget : 0,
    prev: Number.isFinite(numericTarget) ? numericTarget : 0,
    dir: 'flat' as 'up' | 'down' | 'flat',
    lastFormatted: '',
    rafId: 0,
    animating: false,
  });

  // Update target when price changes
  useEffect(() => {
    if (!Number.isFinite(numericTarget)) return;
    const s = sRef.current;
    s.target = numericTarget;

    // Bootstrap lerp on very first valid price
    if (s.lerp === 0 && numericTarget !== 0) {
      s.lerp = numericTarget;
      s.prev = numericTarget;
    }

    if (!s.animating) {
      s.animating = true;
      const tick = () => {
        const st = sRef.current;
        st.lerp += (st.target - st.lerp) * 0.08;

        const formatted = formatLerp(st.lerp);
        if (formatted !== st.lastFormatted) {
          st.lastFormatted = formatted;
          setDisplay(formatted);
        }

        // Momentum direction
        const diff = st.lerp - st.prev;
        const threshold = Math.abs(st.lerp) * 0.00001;
        let newDir: 'up' | 'down' | 'flat' = 'flat';
        if (diff > threshold) newDir = 'up';
        else if (diff < -threshold) newDir = 'down';

        if (newDir !== st.dir) {
          st.dir = newDir;
          if (newDir === 'up') setMomentumColor(colors.status.success);
          else if (newDir === 'down') setMomentumColor(colors.status.error);
          else setMomentumColor(colors.text.primary);
        }

        st.prev = st.lerp;

        // Keep animating until converged
        if (Math.abs(st.target - st.lerp) > Math.abs(st.target) * 0.0000001 + 0.0000001) {
          st.rafId = requestAnimationFrame(tick);
        } else {
          st.lerp = st.target;
          st.animating = false;
        }
      };
      sRef.current.rafId = requestAnimationFrame(tick);
    }
  }, [numericTarget, formatLerp]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelAnimationFrame(sRef.current.rafId);
    };
  }, []);

  return (
    <Text
      style={[styles.currentPrice, { color: momentumColor }]}
      numberOfLines={1}
      adjustsFontSizeToFit
      minimumFontScale={0.5}
    >
      {display}
    </Text>
  );
});

type PortfolioTabsWithLivePricesProps = Omit<React.ComponentProps<typeof PortfolioTabs>, 'livePrices'> & {
  liveCoins: string[];
};

const PortfolioTabsWithLivePrices = React.memo(({ liveCoins, ...props }: PortfolioTabsWithLivePricesProps) => {
  const livePrices = useLivePrices(liveCoins);
  return <PortfolioTabs {...props} livePrices={livePrices} />;
});

type PnlShareCardProps = {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  pnlPercent: number;
  entryPrice: number;
  markPrice: number;
  leverage?: number;
};

const PnlShareCard = ({
  symbol,
  direction,
  pnlPercent,
  entryPrice,
  markPrice,
  leverage,
}: PnlShareCardProps) => {
  const { t } = useTranslation();
  const { formatDisplayPrice: fmtPx } = useDisplayCurrency();
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
          <Text style={styles.pnlPriceValue}>{fmtPx(entryPrice)}</Text>
        </View>
        <View style={styles.pnlPriceCol}>
          <Text style={styles.pnlPriceLabel}>{t('trading.markPrice')}</Text>
          <Text style={styles.pnlPriceValue}>{fmtPx(markPrice)}</Text>
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
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  errorContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  errorText: { fontSize: 16, color: colors.status.error, marginBottom: 16 },
  retryButton: { paddingHorizontal: 24, paddingVertical: 12, backgroundColor: colors.background.tertiary, borderRadius: 8 },
  retryText: { color: colors.text.primary, fontWeight: '600' },
  header: { 
    flexDirection: 'row', 
    alignItems: 'center', 
    paddingHorizontal: 16, 
    paddingVertical: 12, 
    borderBottomWidth: 1, 
    borderBottomColor: colors.border.primary 
  },
  backButton: { padding: 8 },
  headerCenter: { flex: 1, flexDirection: 'row', alignItems: 'center', marginLeft: 8 },
  headerTitle: { marginLeft: 12, minWidth: 0, flexShrink: 1 },
  headerSymbolRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  symbol: { fontSize: 18, fontWeight: '700', color: colors.text.primary },
  headerChevron: { marginLeft: -1 },
  name: { fontSize: 13, color: colors.text.secondary },
  favoriteButton: { padding: 8 },
  alertButton: { padding: 8, marginRight: 4 },
  content: { flex: 1 },
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
  priceSection: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10 },
  priceRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  // Claims remaining width so LivePriceDisplay width churn stays inside this box.
  priceSlot: { flex: 1, minWidth: 0, justifyContent: 'center' },
  priceRowRight: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 },
  currentPrice: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.text.primary,
    fontVariant: ['tabular-nums'],
    width: '100%',
  },
  subPriceRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginTop: 6 },
  miniStatsRow: { flexDirection: 'row', alignItems: 'stretch', gap: 0, marginLeft: 12 },
  miniStat: { alignItems: 'center', paddingHorizontal: 8 },
  miniStatLabel: { fontSize: 9, fontWeight: '700', color: colors.text.tertiary, opacity: 0.6, marginBottom: 2 },
  miniStatValue: { fontSize: 10, fontWeight: '700', color: colors.text.secondary },
  miniStatSep: { width: StyleSheet.hairlineWidth, backgroundColor: colors.text.tertiary, opacity: 0.25, marginVertical: 2 },
  leverageBadge: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 5, paddingVertical: 2, borderRadius: 6, borderWidth: 1, gap: 2, minHeight: 20 },
  leverageText: { fontSize: 10, fontWeight: '700' },
  leverageBadgeUltra: { borderWidth: 0 },
  leverageTextUltra: { color: colors.background.primary },
  preIpoBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 2,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.accent.gold,
    backgroundColor: `${colors.accent.gold}20`,
    gap: 2,
    minHeight: 20,
    flexShrink: 1,
  },
  preIpoBadgeText: { fontSize: 10, fontWeight: '700', color: colors.accent.gold },
  geminiBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.accent.blue,
    backgroundColor: `${colors.accent.blue}15`,
    minHeight: 24,
  },
  geminiLogoContainer: {
    width: 14,
    height: 14,
    position: 'relative',
    justifyContent: 'center',
    alignItems: 'center',
  },
  geminiLogo: {
    width: 14,
    height: 14,
  },
  geminiStar: {
    position: 'absolute',
  },
  geminiStar1: {
    top: -4,
    left: -3,
  },
  geminiStar2: {
    top: -3,
    right: -4,
  },
  geminiStar3: {
    bottom: -3,
    left: 0,
  },
  geminiBadgeText: { color: colors.accent.blue, fontSize: 11, fontWeight: '700' },
  priceChange: { fontSize: 15, fontWeight: '600' },
  tradeButtonContainer: {
    flexDirection: 'row',
    marginHorizontal: 16,
    marginTop: 16,
    marginBottom: 8,
    alignItems: 'stretch',
    gap: 4,
  },
  tradeButtonMain: { 
    flex: 1, 
    flexDirection: 'row', 
    alignItems: 'center', 
    justifyContent: 'center', 
    backgroundColor: colors.accent.gold, 
    paddingVertical: 16, 
    minHeight: 52,
    borderRadius: 12, 
    gap: 8,
  },
  tradeButtonQuick: {
    width: 54,
    height: 54,
    borderRadius: 12,
    overflow: 'hidden',
  },
  tradeButtonQuickInner: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tradeButtonText: { fontSize: 16, fontWeight: '700', color: colors.background.primary },
  earningsCard: { marginHorizontal: 16, marginBottom: 32, padding: 16, backgroundColor: colors.background.card, borderRadius: 12, borderWidth: 1, borderColor: colors.accent.purple },
  earningsHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  earningsTitle: { fontSize: 14, fontWeight: '600', color: colors.text.primary },
  earningsDate: { fontSize: 18, fontWeight: '700', color: colors.accent.purple, marginBottom: 8 },
  earningsNote: { fontSize: 13, color: colors.text.secondary, lineHeight: 20 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    padding: 20,
  },
  modalScrollContent: { flexGrow: 1, justifyContent: 'center' },
  modalCard: {
    backgroundColor: colors.background.primary,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border.primary,
    padding: 16,
  },
  // Demo-mode pill — see trade/[coin].tsx for the master copy.
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
  modalTitle: {
    color: colors.text.primary,
    fontSize: 16,
    fontWeight: '900',
    marginBottom: 2,
  },
  modalSubtitle: {
    color: colors.text.tertiary,
    fontSize: 11,
    fontWeight: '600',
  },
  modalText: {
    color: colors.text.secondary,
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 12,
  },
  modalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6 },
  modalLabel: { color: colors.text.tertiary, fontSize: 12, fontWeight: '700' },
  modalValue: { color: colors.text.primary, fontSize: 12, fontWeight: '800' },
  modalError: { color: colors.status.error, fontSize: 12, fontWeight: '700', marginTop: 6 },
  modalButtons: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 14,
  },
  modalSecondary: { flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center', backgroundColor: colors.background.tertiary, borderWidth: 1, borderColor: colors.border.primary },
  modalSecondaryText: { color: colors.text.primary, fontSize: 13, fontWeight: '800' },
  modalPrimary: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    backgroundColor: colors.accent.gold,
  },
  modalPrimaryText: {
    color: colors.background.primary,
    fontSize: 13,
    fontWeight: '900',
  },
  inputRow: { marginTop: 12 },
  inputLabel: { color: colors.text.tertiary, fontSize: 12, fontWeight: '700', marginBottom: 8 },
  input: { borderWidth: 1, borderColor: colors.border.primary, backgroundColor: colors.background.card, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 12, color: colors.text.primary, fontSize: 14 },
  inputHint: { marginTop: 6, color: colors.text.tertiary, fontSize: 11, fontWeight: '600' },
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
  positionsCard: { borderRadius: 12, padding: 12, borderWidth: 1, borderColor: colors.border.primary, marginHorizontal: 16, marginBottom: 32 },
  positionsHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 10 },
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
  positionActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
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
  searchModalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(10, 10, 15, 0.96)',
  },
  searchModalContainer: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 70,
  },
  searchInputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.background.tertiary,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    gap: 8,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
    color: colors.text.primary,
    paddingVertical: 0,
  },
  searchResultsContainer: {
    paddingTop: 12,
    paddingBottom: 24,
  },
  searchResultItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 12,
    marginBottom: 4,
    backgroundColor: colors.background.tertiary,
    borderWidth: 1,
    borderColor: colors.border.primary,
    gap: 8,
  },
  searchFavoriteButton: {
    padding: 4,
  },
  searchResultContent: {
    flex: 1,
    minWidth: 0,
  },
  searchResultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  searchResultLeft: {
    flex: 1,
    minWidth: 0,
    marginRight: 8,
  },
  searchResultTicker: {
    fontSize: 16,
    fontWeight: '800',
    color: colors.text.primary,
    flexShrink: 0,
  },
  searchResultTickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  searchResultBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border.primary,
    backgroundColor: colors.background.primary,
  },
  searchResultBadgeText: {
    fontSize: 10,
    fontWeight: '800',
    color: colors.accent.gold,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  searchResultName: {
    fontSize: 12,
    color: colors.text.secondary,
    marginTop: 2,
  },
  searchResultPriceColumn: {
    alignItems: 'flex-end',
    minWidth: 80,
    marginRight: 8,
    flexShrink: 0,
  },
  searchResultPrice: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.text.primary,
  },
  searchResultChange: {
    fontSize: 12,
    fontWeight: '700',
    marginTop: 2,
  },
  searchResultCategoryContainer: {
    minWidth: 70,
    maxWidth: 90,
  },
  searchResultCategory: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.accent.gold,
    textAlign: 'right',
  },
  searchEmpty: {
    alignItems: 'center',
    paddingVertical: 40,
  },
  searchEmptyText: {
    fontSize: 14,
    color: colors.text.tertiary,
  },
  searchEmptyClose: {
    marginTop: 12,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: colors.accent.gold,
  },
  searchEmptyCloseText: {
    fontSize: 13,
    fontWeight: '800',
    color: colors.background.primary,
  },
  // Bottom Sheet styles
  bottomSheetOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'flex-end',
  },
  bottomSheetBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  bottomSheetContainer: {
    backgroundColor: colors.background.primary,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingBottom: 120,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: colors.border.primary,
    maxHeight: '75%',
  },
  bottomSheetGlow: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: -100,
    height: 120,
    zIndex: 10,
    overflow: 'visible',
  },
  bottomSheetHandleArea: {
    alignItems: 'center',
    paddingVertical: 12,
  },
  bottomSheetHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.text.tertiary,
  },
  cryptoInfoBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.accent.blue,
    backgroundColor: `${colors.accent.blue}15`,
    minHeight: 24,
  },
  cryptoInfoBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.accent.blue,
  },
  /** Info modals (stock AI + asset details): close is absolutely positioned so it stays in the card corner */
  infoModalCardWrap: {
    position: 'relative',
  },
  infoModalClose: {
    position: 'absolute',
    top: 10,
    right: 10,
    zIndex: 2,
    padding: 6,
  },
  infoModalHeaderContent: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginBottom: 12,
    paddingRight: 40,
  },
  infoModalHeaderTextBlock: {
    flex: 1,
    minWidth: 0,
  },
  cryptoInfoCard: {
    backgroundColor: colors.background.primary,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border.primary,
    padding: 16,
    position: 'relative',
  },
  cryptoInfoHeaderTitles: {
    flex: 1,
    minWidth: 0,
  },
  cryptoInfoDesc: {
    color: colors.text.secondary,
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 4,
  },
  /** Off-screen full-width line count for Info modal — aligns "Show more" with numberOfLines={3} */
  cryptoInfoDescMeasure: {
    position: 'absolute',
    opacity: 0,
    left: 0,
    right: 0,
    width: '100%',
    zIndex: -1,
  },
  readMoreText: {
    color: colors.accent.blue,
    fontSize: 12,
    fontWeight: '700',
    marginTop: 4,
    marginBottom: 10,
  },
  cryptoInfoGrid: {
    gap: 2,
  },
  cryptoInfoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.primary,
  },
  cryptoInfoLabel: {
    color: colors.text.tertiary,
    fontSize: 12,
    fontWeight: '700',
  },
  cryptoInfoValue: {
    color: colors.text.primary,
    fontSize: 13,
    fontWeight: '800',
  },
  cryptoInfoWhitepaper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: `${colors.accent.gold}12`,
    borderWidth: 1,
    borderColor: `${colors.accent.gold}35`,
  },
  cryptoInfoWhitepaperText: {
    flex: 1,
    color: colors.accent.gold,
    fontSize: 13,
    fontWeight: '800',
  },
  cryptoInfoXSearchOuter: {
    marginTop: 14,
  },
  cryptoInfoXSearch: {
    marginTop: 0,
    borderColor: colors.border.primary,
  },
  cryptoInfoXSearchBelowWhitepaper: {
    marginTop: 8,
  },
  cryptoInfoXLogo: {
    width: 16,
    height: 16,
  },
  cryptoInfoXSearchText: {
    flex: 1,
    color: colors.text.primary,
    fontSize: 13,
    fontWeight: '800',
  },

  // ─── Asset onboarding styles ──────────────────────────────────────
  obPulseRing: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderWidth: 2.5,
    borderColor: colors.accent.gold,
  },
  obTooltip: {
    marginHorizontal: 16,
    marginTop: 10,
    marginBottom: 4,
    backgroundColor: colors.background.card,
    borderWidth: 1,
    borderColor: `${colors.accent.gold}40`,
    borderRadius: 16,
    padding: 16,
    shadowColor: colors.accent.gold,
    shadowOpacity: 0.15,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  obTooltipContent: {
    marginBottom: 14,
  },
  obTooltipTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: colors.text.primary,
    marginBottom: 4,
  },
  obTooltipDesc: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.text.secondary,
    lineHeight: 18,
  },
  obTooltipFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  obDots: {
    flexDirection: 'row',
    gap: 6,
  },
  obDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.border.primary,
  },
  obDotActive: {
    backgroundColor: colors.accent.gold,
    width: 20,
  },
  obActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  obSkipText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text.tertiary,
  },
  obActionBtn: {
    borderRadius: 10,
    overflow: 'hidden',
  },
  obActionGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  obActionText: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.background.primary,
  },
  obResetBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 14,
    opacity: 0.5,
  },
  obResetText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.text.tertiary,
  },
});
