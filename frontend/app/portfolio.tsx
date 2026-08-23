import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  TextInput,
  Platform,
  Image,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import * as Haptics from 'expo-haptics';
import ViewShot from 'react-native-view-shot';
import { PnlShareExportFrame } from '../src/components/PnlShareExportFrame';
import { sharePnlPng } from '../src/lib/sharePnlImage';
import MaskedView from '@react-native-masked-view/masked-view';
import { useActiveEthereumWallet } from '../src/hooks/useActiveEthereumWallet';
import { useActiveTradingBook } from '../src/hooks/useActiveTradingBook';
import { isDedicatedSwitcherAgent } from '../src/lib/tradingBook';
import { overlaySignerAgentActive, useSignerTradingSetup } from '../src/hooks/useSignerTradingSetup';
import { useSeamlessSetup } from '../src/providers/SeamlessSetupProvider';
import { useAppStore } from '../src/store/appStore';
import { PortfolioTabs } from '../src/components/PortfolioTabs';
import { TradingBookSwitcher } from '../src/components/TradingBookSwitcher';
import { PortfolioBalanceCardSkeleton } from '../src/components/skeleton/PortfolioBalanceCardSkeleton';
import { PortfolioSummaryCardsSkeleton } from '../src/components/skeleton/PortfolioSummaryCardsSkeleton';
import { TweenedStatText } from '../src/components/TweenedStatText';
import { BouncingDots } from '../src/components/BouncingDots';
import { useClaimBannerTopInset, useTopStripContentHeight } from '../src/components/ClaimTradingCreditBanner';
import { useHyperliquidAccountStream } from '../src/lib/useHyperliquidAccountStream';
import { useLivePrices } from '../src/providers/WebSocketProvider';
import { getPriceLookupKeys, pickPrice } from '../src/lib/priceKeys';
import { fetchAssets, listAiAgents, reportTrade, type AiAgentView } from '../src/lib/api';
import {
  cancelOpenOrder,
  modifyOpenOrder,
  ensureAgentKey,
  getActiveAssetData,
  getHistoricalPnlTimeseries,
  getUserPortfolioSummary,
  getHyperliquidTradingState,
  getOpenOrders,
  mergeRestAndStreamOpenOrders,
  getUserFills,
  marketClosePosition,
  marketCloseSpotPosition,
  placeReduceOnlyTpslTrigger,
  transferUsdBetweenSpotAndPerp,
  getSpotClearinghouseState,
  getSpotMetaAndAssetCtxsCached,
  getSpotSymbolMap,
  setupTradingAccount,
  rotateAgentKey,
  isTradingSetupComplete,
  markTradingSetupComplete,
  isBuilderFeeApproved,
  isPooledAccountMode,
  isRateLimitError,
  computeSpotBalanceUsd,
  type Eip1193Provider,
} from '../src/lib/hyperliquid';
import { humanizeHyperliquidError } from '../src/lib/hyperliquidErrors';
import { colors } from '../src/theme/colors';
import { showToast } from '../src/lib/toast';
import { useTranslation } from 'react-i18next';
import { useDisplayCurrency } from '../src/providers/CurrencyProvider';
import { useAuth } from '../src/providers/AuthContext';
import { formatDisplaySymbol } from '../src/lib/displaySymbols';

/** Survives Portfolio remounts so reconnect / empty-hydrate / mode races can't flash wrong totals. */
const lastKnownPositiveAccountValueByKey = new Map<string, number>();

type PositionTpslModal = {
  coin: string;
  entrySide: 'long' | 'short';
  entryPx: number;
  markPx: number;
  sizeUnits: number;
  marginUsedUsd?: number;
  leverage?: number;
};

export default function PortfolioScreen() {
  const { t } = useTranslation();
  const dc = useDisplayCurrency();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // Top strip (claim or demo banner) absolute-positions over the screen top.
  // Skip the safe-area top edge and pad explicitly when active.
  const topStripActive = useClaimBannerTopInset();
  const topStripContentHeight = useTopStripContentHeight();
  const safeAreaEdges = (topStripActive ? ['left', 'right', 'bottom'] : undefined) as
    | undefined
    | ('top' | 'bottom' | 'left' | 'right')[];
  const safeAreaTopPad = topStripActive ? { paddingTop: insets.top + topStripContentHeight } : undefined;
  const { isAuthenticated, user } = useAppStore();
  // Trading env (mainnet | demo) — see profile.tsx for the toggle. Local
  // setup-complete state must re-evaluate on env flip because both the
  // SecureStore scope and HL's per-network agent / builder records change.
  const tradingEnv = useAppStore((s) => s.tradingEnv);
  const isDemo = tradingEnv === 'demo';
  const { getAccessToken } = useAuth();
  const { wallet: embeddedWallet, address: activeAddr } = useActiveEthereumWallet();
  const embeddedAddress = (activeAddr || '') as `0x${string}`;
  const userAddress = user?.wallet?.address ?? null;
  const routeParams = useLocalSearchParams<{ book?: string }>();
  const userPortfolioAddress = useMemo(() => {
    if (userAddress && userAddress.startsWith('0x')) return userAddress as `0x${string}`;
    return null;
  }, [userAddress]);
  const embeddedPortfolioAddress = useMemo(() => {
    if (embeddedAddress && embeddedAddress.startsWith('0x')) return embeddedAddress as `0x${string}`;
    return null;
  }, [embeddedAddress]);

  const [portfolioTab, setPortfolioTab] = useState<'positions' | 'orders' | 'history'>('positions');
  const [selectedPeriod, setSelectedPeriod] = useState<'day' | 'week' | 'month' | 'allTime'>('day');
  const [cancelingOrderId, setCancelingOrderId] = useState<number | null>(null);
  const [closingPositionKey, setClosingPositionKey] = useState<string | null>(null);
  const [closeAllLoading, setCloseAllLoading] = useState(false);
  const [cancelAllLoading, setCancelAllLoading] = useState(false);
  const [posTpslModal, setPosTpslModal] = useState<PositionTpslModal | null>(null);
  const [posTpEnabled, setPosTpEnabled] = useState(false);
  const [posSlEnabled, setPosSlEnabled] = useState(false);
  const [posTpPxText, setPosTpPxText] = useState('');
  const [posSlPxText, setPosSlPxText] = useState('');
  const [posTpslLoading, setPosTpslLoading] = useState(false);
  const [transferModalOpen, setTransferModalOpen] = useState(false);
  const [spotHoldingsDetailOpen, setSpotHoldingsDetailOpen] = useState(false);
  const [transferDirection, setTransferDirection] = useState<'toPerp' | 'toSpot'>('toPerp');
  const [transferAmountText, setTransferAmountText] = useState('');
  const [isTransferring, setIsTransferring] = useState(false);
  const [showSetupModal, setShowSetupModal] = useState(false);
  const [setupLoading, setSetupLoading] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [setupComplete, setSetupComplete] = useState(false);
  const setupPromptTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  useEffect(() => {
    if (isDemo && transferModalOpen) {
      setTransferModalOpen(false);
      setTransferAmountText('');
    }
  }, [isDemo, transferModalOpen]);

  const { data: aiAgentsForBooks, isFetched: aiAgentsForBooksFetched } = useQuery({
    queryKey: ['ai_agents', 'books', tradingEnv],
    queryFn: async () => {
      const token = await getAccessToken();
      if (!token) return [] as AiAgentView[];
      return (await listAiAgents(token)).agents;
    },
    enabled: isAuthenticated,
    staleTime: 60_000,
    // Server-side agent status changes (auto-pause/stop) must reach the
    // portfolio book switcher without a manual refresh.
    refetchInterval: 60_000,
  });

  const {
    activeTradingBook,
    tradingAddress: bookTradingAddress,
    vaultAddress,
    isDedicatedBook,
    selectDedicatedBook,
    selectMainBook,
  } = useActiveTradingBook();
  const signerSetup = useSignerTradingSetup(isDedicatedBook);

  const dedicatedBooks = useMemo(() => {
    const master = (embeddedAddress || '').toLowerCase();
    return (aiAgentsForBooks ?? []).filter((a) => {
      if (!isDedicatedSwitcherAgent(a)) return false;
      if ((a.tradingEnv === 'demo') !== isDemo) return false;
      if (master && a.hlMasterAddress.toLowerCase() !== master) return false;
      return true;
    });
  }, [aiAgentsForBooks, embeddedAddress, isDemo]);

  const portfolioBook = activeTradingBook.agentId ?? 'master';

  const selectedDedicatedAgent = useMemo(
    () =>
      portfolioBook === 'master'
        ? null
        : dedicatedBooks.find((a) => a.id === portfolioBook) ?? null,
    [portfolioBook, dedicatedBooks],
  );

  const viewAddress = useMemo(() => {
    return (bookTradingAddress || embeddedAddress || '') as `0x${string}`;
  }, [bookTradingAddress, embeddedAddress]);

  // Deep-link: /portfolio?book=<agentId>
  useEffect(() => {
    const id = typeof routeParams.book === 'string' ? routeParams.book : '';
    if (!id) return;
    const agent = dedicatedBooks.find((a) => a.id === id);
    if (agent?.hlSubaccountAddress) {
      selectDedicatedBook({
        agentId: agent.id,
        subAddress: agent.hlSubaccountAddress,
        name: agent.name,
      });
    }
  }, [routeParams.book, dedicatedBooks, selectDedicatedBook]);

  // Drop stale selection if the agent list no longer includes it.
  // Wait until the list has fetched — an empty first paint must not wipe a
  // book chosen on Home (that felt like the chip needing a second tap).
  useEffect(() => {
    if (portfolioBook === 'master') return;
    if (!aiAgentsForBooksFetched) return;
    if (!dedicatedBooks.some((a) => a.id === portfolioBook)) {
      selectMainBook();
    }
  }, [portfolioBook, dedicatedBooks, selectMainBook, aiAgentsForBooksFetched]);

  // Single account WS retargets to active book (Main or Dedicated sub).
  const stream = useHyperliquidAccountStream();
  // Stream retarget lags one paint behind the book switcher — only merge when
  // the socket address matches the selected book (avoids Main↔Dedicated flash).
  const streamMatchesBook =
    !!viewAddress &&
    !!stream.subscribedUser &&
    stream.subscribedUser.toLowerCase() === viewAddress.toLowerCase();
  const hlWsLive = streamMatchesBook && stream.isConnected;

  const {
    data: tradingState,
    refetch: refetchTradingState,
    isPending: tradingStatePending,
    isPlaceholderData: tradingStateIsPlaceholder,
  } = useQuery({
    queryKey: ['hl_trading_state', tradingEnv, viewAddress],
    queryFn: () => getHyperliquidTradingState(viewAddress),
    enabled: !!viewAddress && isAuthenticated,
    staleTime: 5_000,
    refetchInterval: hlWsLive ? 30_000 : 8_000,
    // Keep positions / PnL on screen while the next book fetches. Top-card
    // dollars are gated separately so we don't flash the previous book's equity.
    placeholderData: keepPreviousData,
  });

  // True once the FIRST REST snapshot has landed (stays true across
  // refetches because react-query keeps `data` while re-fetching). Used
  // to gate setup-state writes/reads that depend on REST-only fields
  // (e.g. `accountAbstractionMode`) which the WS synthesizer can't
  // produce on its own. See trade/[coin].tsx for the full rationale.
  const tradingStateReady = !tradingStatePending && !!tradingState;

  const bookSnapshotKey = `${tradingEnv}:${(viewAddress || '').toLowerCase()}`;
  const [figuresBookKey, setFiguresBookKey] = useState<string | null>(null);
  useEffect(() => {
    if (!isAuthenticated || !viewAddress) {
      setFiguresBookKey(null);
      return;
    }
    if (!tradingStatePending && !tradingStateIsPlaceholder && tradingState) {
      setFiguresBookKey(bookSnapshotKey);
    }
  }, [
    isAuthenticated,
    viewAddress,
    bookSnapshotKey,
    tradingState,
    tradingStatePending,
    tradingStateIsPlaceholder,
  ]);
  /** Top-card $ amounts only — don't paint the previous book's equity on switch. */
  const balanceFiguresPending =
    isAuthenticated && !!viewAddress && figuresBookKey !== bookSnapshotKey;

  const { data: openOrders, refetch: refetchOpenOrders } = useQuery({
    queryKey: ['hl_open_orders', tradingEnv, viewAddress],
    queryFn: () => getOpenOrders(viewAddress),
    enabled: !!viewAddress && isAuthenticated,
    staleTime: 5_000,
    refetchInterval: hlWsLive ? 30_000 : 8_000,
  });

  const { data: userFills, refetch: refetchUserFills } = useQuery({
    queryKey: ['hl_user_fills', tradingEnv, viewAddress],
    queryFn: () => getUserFills(viewAddress),
    enabled: !!viewAddress && isAuthenticated,
    staleTime: 10_000,
    refetchInterval: 30_000,
  });

  const { data: pnlTimeseriesUser, isFetching: pnlTimeseriesUserFetching } = useQuery({
    queryKey: ['hl_pnl_timeseries', userPortfolioAddress],
    queryFn: () => getHistoricalPnlTimeseries(userPortfolioAddress as `0x${string}`),
    enabled: !!userPortfolioAddress && isAuthenticated,
    refetchInterval: 60000,
  });

  const { data: pnlTimeseriesEmbedded, isFetching: pnlTimeseriesEmbeddedFetching } = useQuery({
    queryKey: ['hl_pnl_timeseries', embeddedPortfolioAddress],
    queryFn: () => getHistoricalPnlTimeseries(embeddedPortfolioAddress as `0x${string}`),
    enabled: !!embeddedPortfolioAddress && isAuthenticated && embeddedPortfolioAddress !== userPortfolioAddress,
    refetchInterval: 60000,
  });

  const { data: portfolioSummaryUser, isFetching: portfolioSummaryUserFetching } = useQuery({
    queryKey: ['hl_portfolio_summary', userPortfolioAddress],
    queryFn: () => getUserPortfolioSummary(userPortfolioAddress as `0x${string}`),
    enabled: !!userPortfolioAddress && isAuthenticated,
    refetchInterval: 60000,
  });

  const { data: portfolioSummaryEmbedded, isFetching: portfolioSummaryEmbeddedFetching } = useQuery({
    queryKey: ['hl_portfolio_summary', embeddedPortfolioAddress],
    queryFn: () => getUserPortfolioSummary(embeddedPortfolioAddress as `0x${string}`),
    enabled: !!embeddedPortfolioAddress && isAuthenticated && embeddedPortfolioAddress !== userPortfolioAddress,
    refetchInterval: 60000,
  });

  const { data: rwaData } = useQuery({
    queryKey: ['assets'],
    queryFn: fetchAssets,
    staleTime: 30_000,
    // Row metadata / price fallbacks — preserve the 30s cadence the old
    // global refetchInterval default provided.
    refetchInterval: 30_000,
  });

  const { data: spotState, refetch: refetchSpotState } = useQuery({
    queryKey: ['hl_spot_state', tradingEnv, viewAddress],
    queryFn: () => getSpotClearinghouseState(viewAddress),
    enabled: !!viewAddress && isAuthenticated,
    staleTime: 5_000,
    refetchInterval: hlWsLive ? 60_000 : 8_000,
  });

  const { data: dedicatedPnlTimeseries, isFetching: dedicatedPnlFetching } = useQuery({
    queryKey: ['hl_pnl_timeseries', viewAddress, 'dedicated_book'],
    queryFn: () => getHistoricalPnlTimeseries(viewAddress),
    enabled: isDedicatedBook && !!viewAddress && isAuthenticated,
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });

  const { data: dedicatedPortfolioSummary, isFetching: dedicatedSummaryFetching } = useQuery({
    queryKey: ['hl_portfolio_summary', viewAddress, 'dedicated_book'],
    queryFn: () => getUserPortfolioSummary(viewAddress),
    enabled: isDedicatedBook && !!viewAddress && isAuthenticated,
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });

  const { data: spotMetaData } = useQuery({
    queryKey: ['hl_spot_meta', tradingEnv],
    queryFn: () => getSpotMetaAndAssetCtxsCached(),
    staleTime: 5 * 60 * 1000, // Cache for 5 min
  });

  const { data: spotSymbolMap } = useQuery({
    queryKey: ['hl_spot_symbol_map', tradingEnv],
    queryFn: getSpotSymbolMap,
    staleTime: 5 * 60 * 1000,
  });

  // Live stream aggregates — same math as home / DepositPanel. Do not use
  // main-dex `clearinghouseState.accountValue` alone for the headline total.
  const streamPerpAccountValueUsd = useMemo(() => {
    if (!streamMatchesBook) return 0;
    const byDex = stream.clearinghouseStatesByDex;
    if (!byDex) {
      const v = parseFloat(stream.clearinghouseState?.marginSummary?.accountValue ?? '0');
      return Number.isFinite(v) ? v : 0;
    }
    return Object.values(byDex).reduce((sum: number, ch: any) => {
      const v = parseFloat(ch?.marginSummary?.accountValue ?? '0');
      return sum + (Number.isFinite(v) ? v : 0);
    }, 0);
  }, [
    streamMatchesBook,
    stream.clearinghouseStatesByDex,
    stream.clearinghouseState?.marginSummary?.accountValue,
  ]);

  const streamSpotBalanceUsd = useMemo(() => {
    if (!streamMatchesBook) return 0;
    const { spotBalanceUsd: v } = computeSpotBalanceUsd(stream.spotState, spotMetaData);
    return Number.isFinite(v) ? v : 0;
  }, [streamMatchesBook, stream.spotState, spotMetaData]);

  const queryIsPooledAccount = isPooledAccountMode(tradingState?.accountAbstractionMode);
  const accountValueCacheKey = `${tradingEnv}:${viewAddress ?? ''}`;
  const streamHasAccountSnapshot =
    streamMatchesBook &&
    !!(stream.spotState || stream.clearinghouseState || stream.clearinghouseStatesByDex);

  // Mode-aware headline total + sticky last-known positive (mirrors index.tsx /
  // DepositPanel). Prevents focus-refetch races: null abstractionMode briefly
  // applying perp+spot (overcount) or partial spot snapshots (undercount).
  const liveAccountValueUsd = useMemo(() => {
    const restVal = Number.isFinite(tradingState?.accountValueUsd) ? tradingState!.accountValueUsd : null;
    const modeKnown = tradingState?.accountAbstractionMode != null;
    const held = lastKnownPositiveAccountValueByKey.get(accountValueCacheKey);

    let computed: number;
    if (queryIsPooledAccount) {
      // Unified: total = spot pool. Prefer REST when stream undercounts mid-hydrate.
      if (restVal != null && restVal > 0.01 && streamSpotBalanceUsd > 0) {
        computed =
          streamSpotBalanceUsd < restVal * 0.85 ? restVal : streamSpotBalanceUsd;
      } else if (streamSpotBalanceUsd > 0) {
        computed = streamSpotBalanceUsd;
      } else if (restVal != null) {
        computed = restVal;
      } else {
        computed = streamSpotBalanceUsd;
      }
    } else if (!modeKnown) {
      // Without mode, REST may have used perp+spot and double-counted unified
      // accounts. Prefer sticky / spot — never invent a fresh inflated total.
      if (held != null && held > 0.01) computed = held;
      else if (streamSpotBalanceUsd > 0) computed = streamSpotBalanceUsd;
      else if (restVal != null) computed = restVal;
      else computed = 0;
    } else {
      const streamTotal = streamPerpAccountValueUsd + streamSpotBalanceUsd;
      if (streamTotal > 0) computed = streamTotal;
      else if (isDemo) computed = streamTotal;
      else if (restVal != null) computed = restVal;
      else computed = streamTotal;
    }

    if (Number.isFinite(computed) && computed > 0.01) {
      // Only pin sticky totals once mode is known — a null-mode REST result can
      // be perp+spot overcount and must not become the held baseline.
      if (modeKnown) {
        lastKnownPositiveAccountValueByKey.set(accountValueCacheKey, computed);
      }
      return computed;
    }

    if (modeKnown && restVal != null && restVal <= 0.01) {
      lastKnownPositiveAccountValueByKey.delete(accountValueCacheKey);
      return computed;
    }

    if (held != null && held > 0.01) {
      if (!streamHasAccountSnapshot || computed <= 0.01) return held;
    }

    return computed;
  }, [
    accountValueCacheKey,
    isDemo,
    queryIsPooledAccount,
    tradingState?.accountAbstractionMode,
    tradingState?.accountValueUsd,
    streamPerpAccountValueUsd,
    streamSpotBalanceUsd,
    streamHasAccountSnapshot,
  ]);

  const bookTradingState = useMemo(() => {
    const hip3Positions = (tradingState?.positions ?? []).filter((p: any) => String(p.coin).includes(':'));
    // Don't merge the new book's WS snapshot over keepPreviousData from the
    // previous book — that 1→0→1 (or 2→0→1) swap is what bounced the list.
    // Wait for this book's REST so rows swap once, without layout animation.
    if (
      streamMatchesBook &&
      stream.isConnected &&
      stream.clearinghouseState &&
      !tradingStateIsPlaceholder
    ) {
      const ch: any = stream.clearinghouseState;
      const streamByDex: Record<string, any> = stream.clearinghouseStatesByDex ?? {};
      const streamWithdrawable = parseFloat(ch?.withdrawable ?? '0') || 0;
      const accountValueUsd =
        Number.isFinite(liveAccountValueUsd) && liveAccountValueUsd > 0.01
          ? liveAccountValueUsd
          : Number.isFinite(tradingState?.accountValueUsd)
            ? tradingState!.accountValueUsd
            : parseFloat(ch?.marginSummary?.accountValue ?? '0') || 0;
      const withdrawableUsd = Number.isFinite(tradingState?.withdrawableUsd) ? tradingState!.withdrawableUsd : streamWithdrawable;
      const hasBalance = accountValueUsd > 0.01 || withdrawableUsd > 0.01;
      // Build cumFunding lookup from REST data (WS stream doesn't include it)
      const restCumFundingMap = new Map<string, any>();
      (tradingState?.positions ?? []).forEach((rp: any) => {
        if (rp.cumFunding) restCumFundingMap.set(rp.coin, rp.cumFunding);
      });
      const mapStreamPosition = (p: any) => {
        const lev = p.position?.leverage;
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
          marginType,
          cumFunding: p.position?.cumFunding ?? restCumFundingMap.get(p.position.coin) ?? null,
        };
      };
      const streamPositions = (ch?.assetPositions ?? []).map(mapStreamPosition);
      // Live HIP-3 positions from `clearinghouseStatesByDex` (the
      // `allDexsClearinghouseState` sub carries every non-main dex). Without
      // this, HIP-3 (xyz) rows come ONLY from the REST snapshot, so they blink
      // out whenever the WS main snapshot is present but REST is momentarily
      // empty (initial-mount race, or a transient refetch missing the xyz dex)
      // — and they'd only refresh on the 30s REST poll. Mirrors trade/[coin].
      const streamHip3Positions: any[] = [];
      Object.entries(streamByDex).forEach(([dexName, chState]: [string, any]) => {
        if (!dexName || !chState) return; // skip main ("") — handled above
        ((chState?.assetPositions ?? []) as any[]).forEach((p: any) => {
          streamHip3Positions.push(mapStreamPosition(p));
        });
      });
      const merged = new Map<string, any>();
      // Key by coin only so a same-coin size update overwrites the prior
      // entry instead of being re-inserted at the end of the Map (which
      // would visibly bump the row to the bottom on every szi tick and,
      // combined with upstream array-order churn from Hyperliquid's
      // assetPositions, caused live rows to "flip" between snapshots).
      // Order: REST hip3 (oldest) → live stream hip3 → live main (newest) so
      // later writes win on key collision and live values trump stale REST.
      [...hip3Positions, ...streamHip3Positions, ...streamPositions].forEach((p) => merged.set(String(p.coin), p));
      // Stable, deterministic ordering (alphabetical by symbol — same default
      // as Binance / Bybit / OKX). Without this the row order tracks
      // `assetPositions` which Hyperliquid does not guarantee to be stable
      // between WS frames, and we'd see rows oscillate on every tick.
      const orderedPositions = Array.from(merged.values()).sort((a: any, b: any) =>
        String(a?.coin ?? '').localeCompare(String(b?.coin ?? ''), undefined, { sensitivity: 'base' }),
      );
      return {
        accountValueUsd,
        withdrawableUsd,
        hasBalance,
        isAgentActive: tradingState?.isAgentActive ?? false,
        positions: orderedPositions,
        perpAccountValueUsd: tradingState?.perpAccountValueUsd ?? 0,
        spotBalanceUsd: queryIsPooledAccount
          ? accountValueUsd
          : (tradingState?.spotBalanceUsd ?? 0),
        perpPositionsCount: tradingState?.perpPositionsCount ?? 0,
        spotPositionsCount: tradingState?.spotPositionsCount ?? 0,
        perpCrossAccountValueByDex: tradingState?.perpCrossAccountValueByDex ?? {},
        perpCrossMaintenanceMarginUsedByDex: tradingState?.perpCrossMaintenanceMarginUsedByDex ?? {},
        perpWithdrawableByDex: tradingState?.perpWithdrawableByDex ?? {},
        perpInitialMarginAvailableByDex: tradingState?.perpInitialMarginAvailableByDex ?? {},
        accountAbstractionMode: tradingState?.accountAbstractionMode ?? null,
        spotUsdcBalanceUsd: tradingState?.spotUsdcBalanceUsd ?? 0,
        totalIsolatedMarginUsedUsd: tradingState?.totalIsolatedMarginUsedUsd ?? 0,
        totalCrossMaintenanceMarginUsedUsd: tradingState?.totalCrossMaintenanceMarginUsedUsd ?? 0,
      };
    }
    if (!tradingState) return tradingState;
    const accountValueUsd =
      Number.isFinite(liveAccountValueUsd) && liveAccountValueUsd > 0.01
        ? liveAccountValueUsd
        : tradingState.accountValueUsd;
    return {
      ...tradingState,
      accountValueUsd,
      hasBalance: accountValueUsd > 0.01 || tradingState.withdrawableUsd > 0.01,
      ...(queryIsPooledAccount ? { spotBalanceUsd: accountValueUsd } : null),
    };
  }, [
    liveAccountValueUsd,
    queryIsPooledAccount,
    streamMatchesBook,
    stream.clearinghouseState,
    stream.clearinghouseStatesByDex,
    stream.isConnected,
    tradingState,
    tradingStateIsPlaceholder,
  ]);
  const effectiveTradingState = overlaySignerAgentActive(bookTradingState, {
    isDedicatedBook,
    ready: signerSetup.ready,
    isAgentActive: signerSetup.isAgentActive,
  });

  const isHlPooledAccount = isPooledAccountMode(effectiveTradingState?.accountAbstractionMode);
  // Null mode must not look like "standard" — otherwise the spot↔perp transfer
  // button flashes on focus/refetch before unified mode resolves.
  const abstractionModeKnown = effectiveTradingState?.accountAbstractionMode != null;
  // Legacy Standard-mode only (hidden for unified). Not shown on Dedicated books.
  const showSpotPerpTransfer =
    !isDedicatedBook && abstractionModeKnown && !isHlPooledAccount;

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

  const hlOpenOrdersCount = useMemo(() => (effectiveOpenOrders ?? []).length, [effectiveOpenOrders]);

  const combinedSpotBalances = useMemo(() => {
    const restBals = (spotState?.balances ?? []) as any[];
    const restEscrows = (spotState?.evmEscrows ?? []) as any[];
    const streamBals = streamMatchesBook ? ((stream.spotState?.balances ?? []) as any[]) : [];
    const streamEscrows = streamMatchesBook ? ((stream.spotState?.evmEscrows ?? []) as any[]) : [];
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
  }, [
    streamMatchesBook,
    stream.spotState?.balances,
    stream.spotState?.evmEscrows,
    spotState?.balances,
    spotState?.evmEscrows,
  ]);

  const filteredFills = useMemo(() => (userFills ?? []) as any[], [userFills]);

  const openOrderCoins = useMemo(() => {
    const coins = (filteredOpenOrders ?? [])
      .map((o: any) => String(o?.coin ?? o?.order?.coin ?? o?.o?.coin ?? ''))
      .filter(Boolean);
    return Array.from(new Set(coins)).sort();
  }, [filteredOpenOrders]);

  const { data: activeAssetData } = useQuery({
    queryKey: ['hl_active_asset_data', viewAddress, openOrderCoins.join('|')],
    queryFn: async () => {
      if (!openOrderCoins.length) return {};
      const entries = await Promise.all(
        openOrderCoins.map(async (coin) => {
          try {
            const data = await getActiveAssetData(viewAddress, coin);
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
    enabled: !!viewAddress && openOrderCoins.length > 0,
    staleTime: 10_000,
    refetchInterval: 30_000,
  });

  const liveCoins = useMemo(() => {
    const coins: string[] = [];
    (filteredPositions ?? []).forEach((p: any) => {
      getPriceLookupKeys({ coin: String(p.coin ?? ''), isHip3: String(p.coin ?? '').includes(':') }).forEach((key) => coins.push(key));
    });
    (filteredOpenOrders ?? []).forEach((o: any) => {
      getPriceLookupKeys({ coin: String(o.coin ?? ''), isHip3: String(o.coin ?? '').includes(':') }).forEach((key) => coins.push(key));
    });
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

  const livePrices = useLivePrices(liveCoins);

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

  const pickSummary = useCallback((summary?: { allTimePnl: number | null; allTimeVlm: number | null }) => {
    if (!summary) return false;
    return summary.allTimePnl != null || summary.allTimeVlm != null;
  }, []);

  const portfolioSummary = useMemo(() => {
    if (isDedicatedBook) {
      if (dedicatedPortfolioSummary) return dedicatedPortfolioSummary;
      // Hold the last Main summary while the Dedicated book fetches so the
      // PnL/volume cards tween instead of flashing `--` / skeleton.
      if (dedicatedSummaryFetching || dedicatedPnlFetching) {
        if (pickSummary(portfolioSummaryUser)) return portfolioSummaryUser;
        if (pickSummary(portfolioSummaryEmbedded)) return portfolioSummaryEmbedded;
        return portfolioSummaryUser ?? portfolioSummaryEmbedded ?? null;
      }
      return null;
    }
    if (pickSummary(portfolioSummaryUser)) return portfolioSummaryUser;
    if (pickSummary(portfolioSummaryEmbedded)) return portfolioSummaryEmbedded;
    return portfolioSummaryUser ?? portfolioSummaryEmbedded ?? null;
  }, [
    isDedicatedBook,
    dedicatedPortfolioSummary,
    dedicatedSummaryFetching,
    dedicatedPnlFetching,
    pickSummary,
    portfolioSummaryEmbedded,
    portfolioSummaryUser,
  ]);

  const pnlTimeseries = useMemo(() => {
    if (isDedicatedBook) {
      if (dedicatedPnlTimeseries) return dedicatedPnlTimeseries;
      if (dedicatedPnlFetching || dedicatedSummaryFetching) {
        if (portfolioSummary && pickSummary(portfolioSummary)) {
          return portfolioSummary === portfolioSummaryUser ? pnlTimeseriesUser : pnlTimeseriesEmbedded;
        }
        return pnlTimeseriesUser ?? pnlTimeseriesEmbedded ?? null;
      }
      return null;
    }
    if (portfolioSummary && pickSummary(portfolioSummary)) {
      return portfolioSummary === portfolioSummaryUser ? pnlTimeseriesUser : pnlTimeseriesEmbedded;
    }
    return pnlTimeseriesUser ?? pnlTimeseriesEmbedded ?? null;
  }, [
    isDedicatedBook,
    dedicatedPnlTimeseries,
    dedicatedPnlFetching,
    dedicatedSummaryFetching,
    pickSummary,
    pnlTimeseriesEmbedded,
    pnlTimeseriesUser,
    portfolioSummary,
    portfolioSummaryEmbedded,
    portfolioSummaryUser,
  ]);

  const selectedEntry = useMemo(() => {
    if (!pnlTimeseries) return null;
    return pnlTimeseries[selectedPeriod] ?? null;
  }, [pnlTimeseries, selectedPeriod]);
  
  const selectedPnl = useMemo(() => {
    // IMPORTANT: We use pnlHistory (pure trading PnL) NOT accountValueHistory
    // pnlHistory excludes deposits/withdrawals and only reflects trading performance
    // For "allTime", the last value in pnlHistory should be the total cumulative PnL from account creation
    
    // --- HL PnL ---
    let hlPnl: number | null = null;
    if (selectedPeriod === 'allTime') {
      const allTimeHistory = pnlTimeseries?.allTime?.pnlHistory ?? [];
      if (allTimeHistory.length > 0) {
        const last = allTimeHistory[allTimeHistory.length - 1]?.[1];
        const val = typeof last === 'string' ? parseFloat(last) : typeof last === 'number' ? last : NaN;
        if (Number.isFinite(val)) hlPnl = val;
      }
      if (hlPnl === null && portfolioSummary?.allTimePnl != null) {
        hlPnl = portfolioSummary.allTimePnl;
      }
    } else {
      const history = selectedEntry?.pnlHistory ?? [];
      const last = history.length ? history[history.length - 1]?.[1] : null;
      const val = typeof last === 'string' ? parseFloat(last) : typeof last === 'number' ? last : NaN;
      if (Number.isFinite(val)) hlPnl = val;
    }

    return hlPnl;
  }, [portfolioSummary?.allTimePnl, selectedEntry, selectedPeriod, pnlTimeseries?.allTime]);

  const selectedVolume = useMemo(() => {
    // --- HL Volume ---
    let hlVlm: number | null = null;
    if (selectedPeriod === 'allTime' && portfolioSummary?.allTimeVlm != null) {
      hlVlm = portfolioSummary.allTimeVlm;
    } else {
      const raw = selectedEntry?.vlm ?? null;
      const val = typeof raw === 'string' ? parseFloat(raw) : NaN;
      if (Number.isFinite(val)) hlVlm = val;
    }

    return hlVlm;
  }, [portfolioSummary?.allTimeVlm, selectedEntry, selectedPeriod]);

  // Show a branded loader in the Performance cards on first load instead of
  // a dashed placeholder. "Loading" here means: we're authenticated, we have
  // an address to query, and the underlying HL queries haven't delivered any
  // payload yet. Once data arrives (even if the user has no trades and the
  // values end up null / $0), we fall back to the normal `--` / formatted
  // output so the cards don't spin forever for brand-new accounts.
  const isBalanceCardLoading = useMemo(() => {
    if (!isAuthenticated) return false;
    if (!viewAddress) return false;
    // First visit only. Book switches keep the card and swap just the $ rows.
    if (figuresBookKey != null) return false;
    return !tradingStateReady;
  }, [isAuthenticated, viewAddress, figuresBookKey, tradingStateReady]);

  const isPerfLoading = useMemo(() => {
    if (!isAuthenticated) return false;
    // First visit only. Book switches keep the PnL/volume cards mounted so
    // the row doesn't swap to skeleton (that was the screen "shake").
    if (figuresBookKey != null) return false;
    if (isDedicatedBook) {
      if (!viewAddress) return false;
      if (pnlTimeseries || portfolioSummary) return false;
      return dedicatedPnlFetching || dedicatedSummaryFetching;
    }
    if (!userPortfolioAddress && !embeddedPortfolioAddress) return false;
    if (pnlTimeseries || portfolioSummary) return false;
    return (
      pnlTimeseriesUserFetching ||
      pnlTimeseriesEmbeddedFetching ||
      portfolioSummaryUserFetching ||
      portfolioSummaryEmbeddedFetching
    );
  }, [
    isAuthenticated,
    figuresBookKey,
    isDedicatedBook,
    viewAddress,
    dedicatedPnlFetching,
    dedicatedSummaryFetching,
    userPortfolioAddress,
    embeddedPortfolioAddress,
    pnlTimeseries,
    portfolioSummary,
    pnlTimeseriesUserFetching,
    pnlTimeseriesEmbeddedFetching,
    portfolioSummaryUserFetching,
    portfolioSummaryEmbeddedFetching,
  ]);

  const formatSignedUsd = useCallback((n: number): string => {
    if (!Number.isFinite(n)) return '--';
    return dc.formatDisplaySigned(n);
  }, [dc.formatDisplaySigned]);

  const formatUsd = useCallback((n: number | null) => {
    if (n == null || !Number.isFinite(n)) return '--';
    return dc.formatDisplayPrice(n);
  }, [dc.formatDisplayPrice]);

  const formatVolume = useCallback((n: number | null) => {
    if (n == null || !Number.isFinite(n)) return '--';
    return dc.formatDisplayVolume(n);
  }, [dc.formatDisplayVolume]);

  const formatPnlSummary = useCallback((n: number) => {
    if (!Number.isFinite(n)) return '--';
    return `$${Math.abs(n).toFixed(2)}${n >= 0 ? '+' : '-'}`;
  }, []);

  const formatVolumeNumber = useCallback(
    (n: number) => {
      if (!Number.isFinite(n)) return '--';
      return dc.formatDisplayVolume(n);
    },
    [dc.formatDisplayVolume],
  );

  const formatPrice = (price: string | null | undefined): string => {
    if (!price) return '--';
    return dc.formatDisplayPrice(parseFloat(price));
  };

  const formatPriceNum = (n: number | null | undefined): string => {
    if (n === null || n === undefined || !Number.isFinite(n)) return '--';
    return dc.formatDisplayPrice(n);
  };

  const safeNum = (x: any) => {
    const n = typeof x === 'number' ? x : parseFloat(String(x ?? ''));
    return Number.isFinite(n) ? n : NaN;
  };

  const formatShortTime = (ms: number | string | null | undefined): string => {
    const n = typeof ms === 'number' ? ms : parseFloat(String(ms ?? ''));
    if (!Number.isFinite(n)) return '--';
    const d = new Date(n);
    if (Number.isNaN(d.getTime())) return '--';
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

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
    const delta = entrySide === 'long' ? posTpPx - entryPx : entryPx - posTpPx;
    return delta * sizeUnits;
  }, [posTpEnabled, posTpPx, posTpslModal]);

  const posSlPnlUsd = useMemo(() => {
    if (!posTpslModal || !posSlEnabled || !posSlPx) return undefined;
    const { entryPx, entrySide, sizeUnits } = posTpslModal;
    const delta = entrySide === 'long' ? posSlPx - entryPx : entryPx - posSlPx;
    return delta * sizeUnits;
  }, [posSlEnabled, posSlPx, posTpslModal]);

  const getPosTpslRoePct = useCallback((pnlUsd: number | undefined) => {
    if (!posTpslModal || typeof pnlUsd !== 'number' || !Number.isFinite(pnlUsd)) return undefined;
    const directMargin = safeNum(posTpslModal.marginUsedUsd);
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
      showToast(e?.message ? humanizeHyperliquidError(String(e.message)).message : t('errors.cancelFailed'), t('errors.cancelFailed'));
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
          pickPrice(livePrices, { coin: symbol, isHip3: symbol.includes(':') }) ??
          pickPrice(hip3Prices, { coin: symbol, isHip3: symbol.includes(':') });
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
            pickPrice(livePrices, { coin: symbol, isHip3: symbol.includes(':') }) ??
            pickPrice(hip3Prices, { coin: symbol, isHip3: symbol.includes(':') });
          if (refreshed) symbolOraclePx = parseFloat(refreshed);
        }
      }
      showToast(t('portfolio.positionClosed'));
      await Promise.all([
        refetchTradingState(),
        refetchOpenOrders(),
        // Spot close lands in spotState.balances + fills (entry cost for PnL).
        // Without refetching userFills, the row's entry/PnL stays stale until
        // the 30s poll tick or a screen re-mount.
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
      const h = humanizeHyperliquidError(e?.message ? String(e.message) : '');
      showToast(h.message, h.title);
    } finally {
      setClosingPositionKey(null);
    }
  }, [embeddedAddress, embeddedWallet, hip3Prices, livePrices, refetchOpenOrders, refetchSpotState, refetchTradingState, refetchUserFills, getAccessToken, t, vaultAddress]);

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
            (pickPrice(livePrices, { coin: spotSymbol }) ?? pickPrice(hip3Prices, { coin: spotSymbol }));
          const markPxNum = markPxStr ? parseFloat(String(markPxStr)) : NaN;
          const valueUsd = Number.isFinite(markPxNum) ? available * markPxNum : NaN;
          if (Number.isFinite(valueUsd) && valueUsd < SPOT_DUST_USD) return;
          spotPositionsToClose.push({ symbol: spotSymbol, szi: String(available) });
        });

        // Close perp positions — wrap each so one failure doesn't abort the batch.
        // We allow ONE reduce-only retry per leg with a fresh price. This
        // catches HL's per-order rejections (price-band, "zero size") that
        // occur disproportionately on HIP-3 books between sequential closes
        // because mid drifts ~200-400ms while the previous leg signs/fills.
        // Reduce-only is the safety net: a retry can never oversell — at
        // worst HL rejects it as zero-size, no double-fill possible.
        //
        // 429 handling: HL throttles abused addresses to 1 req/10s. A short
        // retry inside that window just re-trips. When `isRateLimitError`
        // matches we wait ~6s before the second attempt instead of 350ms,
        // so the throttle window has a real chance to recover. We also
        // pace each leg with a 200ms inter-leg gap to avoid driving the
        // address-based bucket into throttle in the first place.
        for (let i = 0; i < hlPos.length; i++) {
          const p = hlPos[i];
          const symbol = String(p?.coin ?? '');
          const szi = String(p?.szi ?? '');
          if (!symbol || !szi) continue;
          if (i > 0) await new Promise((r) => setTimeout(r, 200));
          const isSpot = symbol.startsWith('@') || symbol.toUpperCase().includes('/USDC');
          let attemptOraclePx: number | undefined = (() => {
            const px =
              pickPrice(livePrices, { coin: symbol, isHip3: symbol.includes(':') }) ??
              pickPrice(hip3Prices, { coin: symbol, isHip3: symbol.includes(':') });
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
                pickPrice(livePrices, { coin: symbol, isHip3: symbol.includes(':') }) ??
                pickPrice(hip3Prices, { coin: symbol, isHip3: symbol.includes(':') });
              if (refreshed) attemptOraclePx = parseFloat(refreshed);
            }
          }
        }

        // Close spot positions
        for (const sp of spotPositionsToClose) {
          const symbolLivePrice = pickPrice(livePrices, { coin: sp.symbol }) ?? pickPrice(hip3Prices, { coin: sp.symbol });
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
      showToast(e?.message ? humanizeHyperliquidError(String(e.message)).message : t('errors.closeAllFailed'), t('errors.closeAllFailed'));
    } finally {
      setCloseAllLoading(false);
    }
  }, [embeddedAddress, embeddedWallet, filteredPositions, hip3Prices, livePrices, refetchOpenOrders, refetchSpotState, refetchTradingState, refetchUserFills, spotState?.balances, spotSymbolMap?.byBase, stream.spotState?.balances, getAccessToken, vaultAddress]);

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
      showToast(e?.message ? humanizeHyperliquidError(String(e.message)).message : t('errors.cancelAllFailed'), t('errors.cancelAllFailed'));
    } finally {
      setCancelAllLoading(false);
    }
  }, [embeddedAddress, filteredOpenOrders, refetchOpenOrders, vaultAddress]);

  const spotUsdcBalance = useMemo(() => {
    const balances = spotState?.balances ?? [];
    const usdcBal = balances.find((b: any) => Number(b?.token) === 0);
    const total = usdcBal ? parseFloat(String(usdcBal.total ?? '0')) : 0;
    const hold = usdcBal ? parseFloat(String(usdcBal.hold ?? '0')) : 0;
    const available = (Number.isFinite(total) ? total : 0) - (Number.isFinite(hold) ? hold : 0);
    return Math.max(0, available);
  }, [spotState]);

  // Calculate detailed spot balance breakdown (USDC vs holdings vs dust)
  const spotBalanceBreakdown = useMemo(() => {
    const balances = spotState?.balances ?? [];
    if (!balances.length) return { usdc: 0, holdings: [], totalHoldingsUsd: 0, dustTokens: [], totalDustUsd: 0 };

    const meta = spotMetaData?.[0];
    const assetCtxs = spotMetaData?.[1] ?? [];
    const tokens = meta?.tokens ?? [];
    const universe = meta?.universe ?? [];

    // Find USDC token index
    const usdcToken = tokens.find((t: any) => String(t?.name ?? '').toUpperCase() === 'USDC');
    const usdcIndex = usdcToken ? Number(usdcToken.index) : 0;

    let usdc = 0;
    const holdings: { name: string; amount: number; valueUsd: number }[] = [];
    let totalHoldingsUsd = 0;
    const dustTokens: { name: string; amount: number; valueUsd: number }[] = [];
    let totalDustUsd = 0;
    const DUST_THRESHOLD_USD = 1; // Tokens worth ≤ $1 are dust

    balances.forEach((balance: any) => {
      const tokenIndex = Number(balance?.token ?? -1);
      const totalHold = parseFloat(String(balance?.total ?? '0'));
      if (!Number.isFinite(totalHold) || totalHold <= 0) return;

      // USDC
      if (tokenIndex === usdcIndex) {
        usdc = totalHold;
        return;
      }

      // Find token info
      const token = tokens.find((t: any) => Number(t?.index) === tokenIndex);
      const tokenName = formatDisplaySymbol(token?.name ?? `Token#${tokenIndex}`);

      // Calculate USD value using entryNtl or markPx
      const entryNtl = parseFloat(String(balance?.entryNtl ?? ''));
      let valueUsd = NaN;

      if (Number.isFinite(entryNtl) && entryNtl > 0) {
        valueUsd = entryNtl;
      } else {
        // Asset contexts are keyed by universe entry name (e.g. @107), not
        // by the filtered universe array index.
        const universeEntry = universe.find(
          (u: any) =>
            Array.isArray(u?.tokens) &&
            u.tokens.length >= 2 &&
            Number(u.tokens[0]) === tokenIndex &&
            Number(u.tokens[1]) === usdcIndex,
        );
        if (universeEntry?.name) {
          const symbol = String(universeEntry.name).toUpperCase();
          const ctx = assetCtxs.find((c: any) => String(c?.coin ?? '').toUpperCase() === symbol);
          const markPx = parseFloat(String(ctx?.markPx ?? ctx?.midPx ?? ''));
          if (Number.isFinite(markPx) && markPx > 0) {
            valueUsd = totalHold * markPx;
          }
        }
      }

      if (Number.isFinite(valueUsd) && valueUsd > 0) {
        if (valueUsd > DUST_THRESHOLD_USD) {
          holdings.push({ name: tokenName, amount: totalHold, valueUsd });
          totalHoldingsUsd += valueUsd;
        } else {
          dustTokens.push({ name: tokenName, amount: totalHold, valueUsd });
          totalDustUsd += valueUsd;
        }
      }
    });

    // Sort by value descending
    holdings.sort((a, b) => b.valueUsd - a.valueUsd);
    dustTokens.sort((a, b) => b.valueUsd - a.valueUsd);

    return { usdc, holdings, totalHoldingsUsd, dustTokens, totalDustUsd };
  }, [spotMetaData, spotState]);

  const spotAssetsLabel = useMemo(() => {
    const names = spotBalanceBreakdown.holdings.map((h) => h.name);
    if (!names.length) return null;
    const visible = names.slice(0, 2).join(', ');
    return names.length > 2 ? `${visible} +${names.length - 2}` : visible;
  }, [spotBalanceBreakdown.holdings]);

  /** More than one non-dust spot token: show compact row + breakdown modal (dust only stays on the old single-line pattern). */
  const showMultiSpotHoldingsDetail = spotBalanceBreakdown.holdings.length >= 2;

  const perpWithdrawable = useMemo(() => {
    if (isHlPooledAccount) return effectiveTradingState?.withdrawableUsd ?? 0;
    const mainDexWithdrawable = effectiveTradingState?.perpWithdrawableByDex?.[''];
    const n = typeof mainDexWithdrawable === 'number'
      ? mainDexWithdrawable
      : Number(mainDexWithdrawable ?? NaN);
    return Number.isFinite(n) ? Math.max(0, n) : 0;
  }, [effectiveTradingState?.perpWithdrawableByDex, effectiveTradingState?.withdrawableUsd, isHlPooledAccount]);

  const transferAvailableUsd = useMemo(() => {
    if (isHlPooledAccount) return 0;
    return transferDirection === 'toPerp' ? spotUsdcBalance : perpWithdrawable;
  }, [isHlPooledAccount, perpWithdrawable, spotUsdcBalance, transferDirection]);

  useEffect(() => {
    if (transferModalOpen && isHlPooledAccount) {
      setTransferModalOpen(false);
      setTransferAmountText('');
    }
  }, [isHlPooledAccount, transferModalOpen]);

  const handleTransferMax = useCallback(() => {
    // Reduce by 0.01 to avoid "not enough balance" errors from rounding/timing
    const maxAmount = Math.max(0, transferAvailableUsd - 0.01);
    setTransferAmountText(maxAmount.toFixed(2));
  }, [transferAvailableUsd]);

  const submitTransfer = useCallback(async () => {
    if (!embeddedAddress) {
      showToast(t('errors.pleaseConnectWallet'));
      return;
    }
    const amt = parseFloat(transferAmountText.replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(amt) || amt <= 0) {
      showToast(t('errors.invalidAmount'), t('errors.enterValidAmount'));
      return;
    }
    if (amt < 1) {
      showToast('Minimum transfer amount is 1 USDC');
      return;
    }
    if (amt > transferAvailableUsd) {
      showToast(t('errors.insufficientBalance'), t('errors.amountExceedsBalance'));
      return;
    }
    if (isHlPooledAccount) {
      showToast(
        t('portfolio.unifiedNoTransferNeeded', 'Unified balances do not need spot/perp transfers.'),
        t('portfolio.transferUnavailable', 'Transfer unavailable'),
      );
      return;
    }
    try {
      setIsTransferring(true);

      // Hyperliquid spot ↔ perp transfer via wallet provider
      if (!embeddedWallet) {
        showToast(t('errors.pleaseConnectWallet'));
        return;
      }
      const provider = (await embeddedWallet.getProvider()) as unknown as Eip1193Provider;
      await transferUsdBetweenSpotAndPerp({
        userWalletProvider: provider,
        userAddress: embeddedAddress,
        amountUsd: amt.toFixed(2),
        toPerp: transferDirection === 'toPerp',
      });
      await refetchTradingState();

      showToast(t('portfolio.transferred', { amount: amt.toFixed(2) }));
      setTransferModalOpen(false);
      setTransferAmountText('');
    } catch (e: any) {
      showToast(e?.message ? humanizeHyperliquidError(String(e.message)).message : t('errors.transferFailed'), t('errors.transferFailed'));
    } finally {
      setIsTransferring(false);
    }
  }, [embeddedAddress, embeddedWallet, isHlPooledAccount, refetchTradingState, transferAmountText, transferAvailableUsd, transferDirection]);

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
    // mode are all confirmed. See trade/[coin].tsx for the rationale.
    //
    // Bail out while REST tradingState hasn't shipped yet. During the
    // mount window the WS-derived `effectiveTradingState` may report
    // `isAgentActive=true` while `accountAbstractionMode` is still null
    // (REST-only field), which would falsely downgrade an already-correct
    // `setupComplete=true` and pop the seamless-trading modal.
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
    // Wait for `accountAbstractionMode` to settle before deciding.
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

  // Silent setup now runs app-wide in SeamlessSetupProvider so its quiet
  // retries survive navigation between screens. Privy embedded wallets sign
  // without a popup and the builder fee is disclosed in the ToS, so we never
  // prompt up-front — the modal below is only a FALLBACK when the silent
  // first-run exhausts its retries. Here we just consume the provider's status
  // for that gate, and pause it while a manual "Activate" runs.
  const {
    autoSetupInFlight,
    autoSetupFailed,
    setupComplete: globalSetupComplete,
    pauseAutoSetup,
    resumeAutoSetup,
    isExternalWalletUser,
  } = useSeamlessSetup();

  // Reflect a confirmed global setup into local state immediately, rather than
  // waiting for the next REST/WS-driven auto-mark pass.
  useEffect(() => {
    if (globalSetupComplete) setSetupComplete(true);
  }, [globalSetupComplete]);

  // Setup modal trigger: if user has balance but setup is not complete =>
  // prompt to setup. Gates on `!setupComplete` (agent active + builder fee
  // approved + unified/portfolio) so users with active agent but
  // unapproved builder fee get re-prompted. See trade/[coin].tsx for
  // the full rationale.
  //
  // We also wait for `tradingStateReady` before arming the prompt:
  // WS-derived `hasBalance` can be true on mount before REST ships
  // `accountAbstractionMode`, and the auto-mark effect above can't
  // confirm setupComplete in that window. Without this guard the modal
  // could pop transiently before settling closed.
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

  // Refresh Hyperliquid snapshots when returning to this screen.
  useFocusEffect(
    useCallback(() => {
      refetchTradingState();
      refetchOpenOrders();
    }, [refetchOpenOrders, refetchTradingState]),
  );

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
  }, [embeddedAddress, embeddedWallet, pauseAutoSetup, resumeAutoSetup]);

  const handleBack = useCallback(() => {
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    router.back();
  }, [router]);

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
      showToast(e?.message ? String(e.message) : 'Failed to generate image');
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

  return (
    <SafeAreaView style={[styles.container, safeAreaTopPad]} edges={safeAreaEdges}>
      <View style={styles.header}>
        <TouchableOpacity onPress={handleBack} style={styles.backButton}>
          <Ionicons name="arrow-back" size={22} color={colors.text.primary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('profile.portfolio')}</Text>
        <View style={{ width: 32 }} />
      </View>

      <ScrollView
        style={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: 80 + Math.max(0, insets.bottom) }}
      >
        {isBalanceCardLoading ? (
          <PortfolioBalanceCardSkeleton />
        ) : (
        <LinearGradient
          colors={['#1a1a2e', '#16213e', '#0f0f1a']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.balanceCard}
        >
          <Text style={styles.summaryLabel} numberOfLines={1}>
            {isDedicatedBook
              ? t('portfolio.agentBookBalance', {
                  name: selectedDedicatedAgent?.name ?? t('aiAgents.title'),
                })
              : tradingEnv === 'demo'
                ? t('demo.totalDemoBalance')
                : t('portfolio.totalBalance')}
          </Text>
          <View style={styles.balanceTotalSlot}>
            {balanceFiguresPending ? (
              <BouncingDots color={colors.text.tertiary} dotSize={5} pulse style={styles.figureDots} />
            ) : (
              <Text style={styles.balanceTotal} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
                {formatUsd(effectiveTradingState?.accountValueUsd ?? null)}
              </Text>
            )}
          </View>
          <View style={styles.balanceBreakdown}>
            <View style={styles.balanceBreakdownItem}>
              <View style={styles.balanceBreakdownLabelRow}>
                <View style={[styles.balanceIndicator, { backgroundColor: colors.accent.gold }]} />
                <Text style={styles.balanceBreakdownLabel}>
                  {isHlPooledAccount
                    ? t('deposit.tradeBalance', 'Trade Balance')
                    : t('portfolio.perp')}
                </Text>
              </View>
              <View style={styles.balanceBreakdownValueSlot}>
                {balanceFiguresPending ? (
                  <BouncingDots color={colors.text.tertiary} dotSize={3} pulse style={styles.figureDots} />
                ) : (
                  <Text style={styles.balanceBreakdownValue}>
                    {formatUsd(
                      isHlPooledAccount
                        ? (effectiveTradingState?.accountValueUsd ?? null)
                        : (effectiveTradingState?.perpAccountValueUsd ?? null)
                    )}
                  </Text>
                )}
              </View>
            </View>
            {isHlPooledAccount ? (
              <>
                <View style={styles.balanceBreakdownDivider} />
                <View style={styles.balanceBreakdownItem}>
                  <View style={styles.balanceBreakdownLabelRow}>
                    <View style={[styles.balanceIndicator, { backgroundColor: 'rgba(59, 130, 246, 0.8)' }]} />
                    <View style={styles.spotBreakdownTitleCluster}>
                      <Text style={[styles.balanceBreakdownLabel, styles.spotBreakdownTitleText]} numberOfLines={1}>
                        {t('portfolio.spotAssets', 'Spot Assets')}
                      </Text>
                      {showMultiSpotHoldingsDetail ? (
                        <TouchableOpacity
                          onPress={() => {
                            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                            setSpotHoldingsDetailOpen(true);
                          }}
                          activeOpacity={0.7}
                          accessibilityRole="button"
                          accessibilityLabel={t('portfolio.viewSpotHoldingsBreakdown')}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          style={styles.spotBreakdownLabelIconHit}
                        >
                          <Ionicons name="chevron-forward-circle-outline" size={16} color={colors.accent.gold} />
                        </TouchableOpacity>
                      ) : null}
                    </View>
                  </View>
                  <View style={styles.balanceBreakdownValueSlot}>
                    {balanceFiguresPending ? (
                      <BouncingDots color={colors.text.tertiary} dotSize={3} pulse style={styles.figureDots} />
                    ) : (
                      <Text style={styles.balanceBreakdownValue}>
                        {formatUsd(spotBalanceBreakdown.totalHoldingsUsd)}
                      </Text>
                    )}
                  </View>
                  <View style={styles.balanceBreakdownSubtextSlot}>
                    {showMultiSpotHoldingsDetail ? (
                      <Text style={styles.balanceBreakdownSubtext} numberOfLines={1}>
                        {t('portfolio.spotHoldingsSummaryMulti', { count: spotBalanceBreakdown.holdings.length })}
                        {spotBalanceBreakdown.totalDustUsd > 0.01 ? ` · ${t('portfolio.spotIncludesDustHint')}` : ''}
                      </Text>
                    ) : (spotAssetsLabel || spotBalanceBreakdown.totalDustUsd > 0.01) ? (
                      <Text style={styles.balanceBreakdownSubtext} numberOfLines={1}>
                        {spotAssetsLabel ?? ''}
                        {spotBalanceBreakdown.totalDustUsd > 0.01
                          ? `${spotAssetsLabel ? ' + ' : ''}$${spotBalanceBreakdown.totalDustUsd.toFixed(2)} dust`
                          : ''}
                      </Text>
                    ) : null}
                  </View>
                </View>
              </>
            ) : (
              <>
                <View style={styles.balanceBreakdownDivider} />
                <View style={styles.balanceBreakdownItem}>
                  <View style={styles.balanceBreakdownLabelRow}>
                    <View style={[styles.balanceIndicator, { backgroundColor: 'rgba(59, 130, 246, 0.8)' }]} />
                    <View style={styles.spotBreakdownTitleCluster}>
                      <Text style={[styles.balanceBreakdownLabel, styles.spotBreakdownTitleText]} numberOfLines={1}>
                        {t('trading.spot')}
                      </Text>
                      {showMultiSpotHoldingsDetail ? (
                        <TouchableOpacity
                          onPress={() => {
                            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                            setSpotHoldingsDetailOpen(true);
                          }}
                          activeOpacity={0.7}
                          accessibilityRole="button"
                          accessibilityLabel={t('portfolio.viewSpotHoldingsBreakdown')}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          style={styles.spotBreakdownLabelIconHit}
                        >
                          <Ionicons name="chevron-forward-circle-outline" size={16} color={colors.accent.gold} />
                        </TouchableOpacity>
                      ) : null}
                    </View>
                  </View>
                  <View style={styles.balanceBreakdownValueSlot}>
                    {balanceFiguresPending ? (
                      <BouncingDots color={colors.text.tertiary} dotSize={3} pulse style={styles.figureDots} />
                    ) : (
                      <Text style={styles.balanceBreakdownValue}>
                        {formatUsd(effectiveTradingState?.spotBalanceUsd ?? null)}
                      </Text>
                    )}
                  </View>
                  <View style={styles.balanceBreakdownSubtextSlot}>
                    {(spotBalanceBreakdown.totalHoldingsUsd > 0.01 || spotBalanceBreakdown.totalDustUsd > 0.01) ? (
                      showMultiSpotHoldingsDetail ? (
                        <Text style={styles.balanceBreakdownSubtext} numberOfLines={1}>
                          {`$${spotBalanceBreakdown.usdc.toFixed(2)} USDC + $${spotBalanceBreakdown.totalHoldingsUsd.toFixed(2)} · ${t('portfolio.spotHoldingsSummaryMulti', {
                            count: spotBalanceBreakdown.holdings.length,
                          })}`}
                          {spotBalanceBreakdown.totalDustUsd > 0.01 ? ` · ${t('portfolio.spotIncludesDustHint')}` : ''}
                        </Text>
                      ) : (
                        <Text style={styles.balanceBreakdownSubtext} numberOfLines={1}>
                          ${spotBalanceBreakdown.usdc.toFixed(2)} USDC
                          {spotBalanceBreakdown.totalHoldingsUsd > 0.01
                            ? ` + $${spotBalanceBreakdown.totalHoldingsUsd.toFixed(2)} ${spotBalanceBreakdown.holdings.map((h) => h.name).join(', ')}`
                            : ''}
                          {spotBalanceBreakdown.totalDustUsd > 0.01
                            ? ` + $${spotBalanceBreakdown.totalDustUsd.toFixed(2)} dust`
                            : ''}
                        </Text>
                      )
                    ) : null}
                  </View>
                </View>
              </>
            )}
          </View>
          {showSpotPerpTransfer ? (
            <TouchableOpacity
              style={[styles.transferButton, isDemo && styles.transferButtonDisabled]}
              onPress={() => {
                if (!isDemo) setTransferModalOpen(true);
              }}
              disabled={isDemo}
              activeOpacity={isDemo ? 1 : 0.85}
            >
              <Text style={[styles.transferButtonText, isDemo && styles.transferButtonTextDisabled]}>{t('portfolio.perp')}</Text>
              <Ionicons name="swap-horizontal" size={16} color={isDemo ? colors.text.tertiary : colors.accent.gold} />
              <Text style={[styles.transferButtonText, isDemo && styles.transferButtonTextDisabled]}>{t('trading.spot')}</Text>
              <Text style={[styles.transferButtonLabel, isDemo && styles.transferButtonTextDisabled]}>{t('portfolio.transfer')}</Text>
            </TouchableOpacity>
          ) : null}
        </LinearGradient>
        )}

        <View style={styles.sectionDivider}>
          <View style={styles.sectionDividerLine} />
          <Text style={styles.sectionDividerText}>{t('portfolio.performance')}</Text>
          <View style={styles.sectionDividerLine} />
        </View>

        <View style={styles.periodTabs}>
          {[
            { id: 'day', label: t('portfolio.period24h') },
            { id: 'week', label: t('portfolio.period7d') },
            { id: 'month', label: t('portfolio.period30d') },
            { id: 'allTime', label: t('portfolio.periodAllTime') },
          ].map((p) => (
            <TouchableOpacity
              key={p.id}
              style={[styles.periodTab, selectedPeriod === p.id && styles.periodTabActive]}
              onPress={() => setSelectedPeriod(p.id as 'day' | 'week' | 'month' | 'allTime')}
            >
              <Text style={[styles.periodTabText, selectedPeriod === p.id && styles.periodTabTextActive]}>{p.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {isPerfLoading ? (
          <PortfolioSummaryCardsSkeleton />
        ) : (
        <View style={styles.summaryRow}>
          <LinearGradient
            colors={['#1a1a2e', '#16213e', '#0f0f1a']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.summaryCard}
          >
            <Text style={styles.summaryLabel}>{t('portfolio.netPnl')}</Text>
            <TweenedStatText
              value={selectedPnl}
              format={formatPnlSummary}
              animationKey={selectedPeriod}
              style={[styles.summaryValue, { color: selectedPnl !== null && selectedPnl >= 0 ? colors.status.success : colors.status.error }]}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.7}
            />
          </LinearGradient>
          <LinearGradient
            colors={['#1a1a2e', '#16213e', '#0f0f1a']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.summaryCard}
          >
            <Text style={styles.summaryLabel}>{t('portfolio.totalVolume')}</Text>
            <TweenedStatText
              value={selectedVolume}
              format={formatVolumeNumber}
              animationKey={selectedPeriod}
              style={styles.summaryValue}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.7}
            />
          </LinearGradient>
        </View>
        )}

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
          accountLayoutKey={tradingStateIsPlaceholder ? figuresBookKey : bookSnapshotKey}
          positions={filteredPositions}
          openOrders={filteredOpenOrders}
          ordersCountOverride={hlOpenOrdersCount}
          fills={filteredFills}
          livePrices={livePrices}
          hip3Prices={hip3Prices}
          activeAssetData={activeAssetData}
          spotBalances={combinedSpotBalances}
          currentAssetSymbol={undefined}
          currentAssetMarkPx={undefined}
          marginMode="cross"
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
      </ScrollView>

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
            {transferDirection === 'toPerp' && (spotBalanceBreakdown.totalHoldingsUsd > 0.01 || spotBalanceBreakdown.totalDustUsd > 0.01) ? (
              <View style={styles.dustBreakdown}>
                <Text style={styles.dustBreakdownTitle}>
                  {t('portfolio.dustBreakdownNote')}
                </Text>
                <View style={styles.dustBreakdownRow}>
                  <Text style={styles.dustBreakdownLabel}>USDC (transferable)</Text>
                  <Text style={[styles.dustBreakdownValue, { color: colors.accent.gold }]}>
                    ${spotBalanceBreakdown.usdc.toFixed(2)}
                  </Text>
                </View>
                {spotBalanceBreakdown.holdings.map((h) => (
                  <View key={h.name} style={styles.dustBreakdownRow}>
                    <Text style={styles.dustBreakdownLabel}>
                      {h.name} ({h.amount.toFixed(6)})
                    </Text>
                    <Text style={[styles.dustBreakdownValue, { color: colors.text.primary }]}>
                      ${h.valueUsd.toFixed(2)}
                    </Text>
                  </View>
                ))}
                {spotBalanceBreakdown.dustTokens.map((dt) => (
                  <View key={dt.name} style={styles.dustBreakdownRow}>
                    <Text style={styles.dustBreakdownLabel}>
                      {dt.name} ({dt.amount.toFixed(6)})
                    </Text>
                    <Text style={[styles.dustBreakdownValue, { color: colors.text.tertiary }]}>
                      ${dt.valueUsd.toFixed(2)}
                    </Text>
                  </View>
                ))}
                {/*<Text style={styles.dustBreakdownHint}>
                  {spotBalanceBreakdown.holdings.length > 0
                    ? t('portfolio.holdingsBreakdownHint')
                    : t('portfolio.dustBreakdownHint')}
                </Text>*/}
              </View>
            ) : null}
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

      <Modal visible={spotHoldingsDetailOpen} transparent animationType="fade" onRequestClose={() => setSpotHoldingsDetailOpen(false)}>
        <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setSpotHoldingsDetailOpen(false)}>
          <TouchableOpacity style={styles.spotBreakdownModalCard} activeOpacity={1}>
            <Text style={styles.modalTitle}>{t('portfolio.spotHoldingsBreakdownTitle')}</Text>
            <ScrollView style={styles.spotBreakdownModalScroll} showsVerticalScrollIndicator={false} nestedScrollEnabled>
              <View style={styles.dustBreakdownRow}>
                <Text style={styles.dustBreakdownLabel}>{t('portfolio.usdcBalance')}</Text>
                <Text style={[styles.dustBreakdownValue, { color: colors.accent.gold }]}>${spotBalanceBreakdown.usdc.toFixed(2)}</Text>
              </View>
              {spotBalanceBreakdown.holdings.map((h, idx) => (
                <View key={`${h.name}-${idx}`} style={styles.dustBreakdownRow}>
                  <Text style={styles.dustBreakdownLabel} numberOfLines={3}>
                    {h.name} ({h.amount.toFixed(6)})
                  </Text>
                  <Text style={[styles.dustBreakdownValue, { color: colors.text.primary }]}>${h.valueUsd.toFixed(2)}</Text>
                </View>
              ))}
              {spotBalanceBreakdown.dustTokens.length > 0 ? (
                <>
                  <Text style={[styles.dustBreakdownTitle, { marginTop: 12, marginBottom: 4 }]}>{t('portfolio.spotDustHeading')}</Text>
                  {spotBalanceBreakdown.dustTokens.map((dt, idx) => (
                    <View key={`dust-${dt.name}-${idx}`} style={styles.dustBreakdownRow}>
                      <Text style={styles.dustBreakdownLabel} numberOfLines={3}>
                        {dt.name} ({dt.amount.toFixed(6)})
                      </Text>
                      <Text style={[styles.dustBreakdownValue, { color: colors.text.tertiary }]}>${dt.valueUsd.toFixed(2)}</Text>
                    </View>
                  ))}
                  <View style={[styles.dustBreakdownRow, { marginTop: 4 }]}>
                    <Text style={styles.dustBreakdownLabel}>{t('portfolio.spotDustTotalEstimated')}</Text>
                    <Text style={[styles.dustBreakdownValue, { color: colors.text.tertiary }]}>
                      ${spotBalanceBreakdown.totalDustUsd.toFixed(2)}
                    </Text>
                  </View>
                </>
              ) : null}
            </ScrollView>
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.modalSecondary} onPress={() => setSpotHoldingsDetailOpen(false)}>
                <Text style={styles.modalSecondaryText}>{t('common.close')}</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
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

            <Text style={styles.modalText}>{posTpslModal ? formatDisplaySymbol(posTpslModal.coin) : ''}</Text>

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
                    <Text style={styles.inputLabel}>{t('trading.tpTriggerPrice')}</Text>
                    <TextInput
                      value={posTpPxText}
                      onChangeText={setPosTpPxText}
                      keyboardType="decimal-pad"
                      placeholder={posTpslModal ? formatPriceNum(posTpslModal.markPx) : '0'}
                      placeholderTextColor={colors.text.tertiary}
                      style={styles.input}
                    />
                  </View>
                  <Text style={styles.inputHint}>
                    {t('trading.estPnl')}: {typeof posTpPnlUsd === 'number' && Number.isFinite(posTpPnlUsd) ? formatSignedUsd(posTpPnlUsd) : '--'}
                    {(() => {
                      const roePct = getPosTpslRoePct(posTpPnlUsd);
                      return typeof roePct === 'number' && Number.isFinite(roePct) ? ` · ${roePct >= 0 ? '+' : ''}${roePct.toFixed(2)}% ROE` : '';
                    })()}
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
                  </View>
                  <Text style={styles.inputHint}>
                    {t('trading.estPnl')}: {typeof posSlPnlUsd === 'number' && Number.isFinite(posSlPnlUsd) ? formatSignedUsd(posSlPnlUsd) : '--'}
                    {(() => {
                      const roePct = getPosTpslRoePct(posSlPnlUsd);
                      return typeof roePct === 'number' && Number.isFinite(roePct) ? ` · ${roePct >= 0 ? '+' : ''}${roePct.toFixed(2)}% ROE` : '';
                    })()}
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
              <TouchableOpacity style={styles.modalSecondary} onPress={() => setPosTpslModal(null)} disabled={posTpslLoading}>
                <Text style={styles.modalSecondaryText}>{t('common.close')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.modalPrimary}
                onPress={async () => {
                  if (!posTpslModal) return;
                  try {
                    setPosTpslLoading(true);
                    const tpPxNum = Number(posTpPx);
                    const slPxNum = Number(posSlPx);
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
                    showToast(e?.message ? humanizeHyperliquidError(String(e.message)).message : t('errors.failedToSetTpsl'));
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
    </SafeAreaView>
  );
}

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
  const isProfit = pnlPercent >= 0;
  return (
    <View style={styles.pnlCard}>
      <View style={styles.pnlGlowTop} />
      <View style={styles.pnlGlowBottom} />

      <View style={styles.pnlHeader}>
        <View style={styles.pnlLogoWrap}>
          <Image source={require('../assets/images/pnl-logo.webp')} style={styles.pnlLogo} />
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.primary,
  },
  headerTitle: { fontSize: 18, fontWeight: '700', color: colors.text.primary },
  backButton: { padding: 6 },
  content: { flex: 1 },
  sectionDivider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 20,
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
  periodTabs: { flexDirection: 'row', gap: 8, marginHorizontal: 16, marginTop: 0, marginBottom: 2 },
  periodTab: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 9,
    alignItems: 'center',
    backgroundColor: colors.background.tertiary,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  periodTabActive: { backgroundColor: `${colors.accent.gold}25`, borderColor: colors.accent.gold },
  periodTabText: { color: colors.text.secondary, fontSize: 11, fontWeight: '800' },
  periodTabTextActive: { color: colors.accent.gold },
  balanceCard: {
    marginHorizontal: 16,
    marginTop: 16,
    borderRadius: 14,
    padding: 18,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  balanceTotalSlot: {
    height: 34,
    marginBottom: 16,
    justifyContent: 'center',
    alignItems: 'flex-start',
    overflow: 'hidden',
  },
  figureDots: {
    alignSelf: 'flex-start',
  },
  balanceTotal: {
    fontSize: 28,
    lineHeight: 34,
    height: 34,
    includeFontPadding: false,
    color: colors.text.primary,
    fontWeight: '900',
  },
  balanceBreakdownValueSlot: {
    height: 20,
    justifyContent: 'center',
    alignItems: 'flex-start',
    overflow: 'hidden',
  },
  balanceBreakdownValue: {
    fontSize: 16,
    lineHeight: 20,
    height: 20,
    includeFontPadding: false,
    color: colors.text.primary,
    fontWeight: '800',
  },
  balanceBreakdownSubtextSlot: {
    height: 14,
    marginTop: 2,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  balanceBreakdown: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 16,
  },
  balanceBreakdownItem: {
    flex: 1,
  },
  balanceBreakdownLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
    minWidth: 0,
  },
  balanceIndicator: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  balanceBreakdownLabel: {
    fontSize: 12,
    lineHeight: 16,
    includeFontPadding: false,
    color: colors.text.tertiary,
    fontWeight: '700',
  },
  /** Label + chevron hug the start of the row; title text may shrink, icon stays adjacent. */
  spotBreakdownTitleCluster: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 2,
  },
  spotBreakdownTitleText: {
    flexShrink: 1,
    minWidth: 0,
  },
  spotBreakdownLabelIconHit: {
    flexShrink: 0,
    paddingLeft: 2,
  },
  balanceBreakdownSubtext: {
    fontSize: 10,
    lineHeight: 12,
    includeFontPadding: false,
    color: colors.text.tertiary,
    fontWeight: '600',
  },
  spotBreakdownModalCard: {
    backgroundColor: colors.background.primary,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border.primary,
    padding: 16,
    maxHeight: '82%',
    width: '100%',
  },
  spotBreakdownModalScroll: {
    maxHeight: 340,
  },
  balanceBreakdownDivider: {
    width: 1,
    alignSelf: 'stretch',
    minHeight: 56,
    backgroundColor: colors.border.primary,
  },
  summaryRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginHorizontal: 16, marginTop: 10 },
  summaryCard: { flex: 1, minWidth: 110, borderRadius: 14, padding: 18, borderWidth: 1, borderColor: colors.border.primary },
  summaryLabel: { fontSize: 13, color: colors.text.tertiary, fontWeight: '800', marginBottom: 6 },
  summaryValue: { fontSize: 20, color: colors.text.primary, fontWeight: '900' },
  summaryLoader: { height: 24, justifyContent: 'center', alignItems: 'flex-start' },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', padding: 20 },
  modalScrollContent: { flexGrow: 1, justifyContent: 'center' },
  modalCard: { backgroundColor: colors.background.primary, borderRadius: 16, borderWidth: 1, borderColor: colors.border.primary, padding: 16 },
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
  modalTitle: { color: colors.text.primary, fontSize: 16, fontWeight: '900', marginBottom: 8 },
  modalText: { color: colors.text.secondary, fontSize: 13, lineHeight: 18, marginBottom: 12 },
  modalError: { color: colors.status.error, fontSize: 12, marginBottom: 8, textAlign: 'center' },
  modalButtons: { flexDirection: 'row', gap: 10, marginTop: 14 },
  modalSecondary: { flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center', backgroundColor: colors.background.tertiary, borderWidth: 1, borderColor: colors.border.primary },
  modalSecondaryText: { color: colors.text.primary, fontSize: 13, fontWeight: '800' },
  modalPrimary: { flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center', backgroundColor: colors.accent.gold },
  modalPrimaryText: { color: colors.background.primary, fontSize: 13, fontWeight: '900' },
  modalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6 },
  modalLabel: { color: colors.text.tertiary, fontSize: 12, fontWeight: '700' },
  modalValue: { color: colors.text.primary, fontSize: 12, fontWeight: '800' },
  inputRow: { marginTop: 12 },
  inputLabel: { color: colors.text.tertiary, fontSize: 12, fontWeight: '700', marginBottom: 8 },
  input: { borderWidth: 1, borderColor: colors.border.primary, backgroundColor: colors.background.card, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 12, color: colors.text.primary, fontSize: 14 },
  inputHint: { marginTop: 6, color: colors.text.tertiary, fontSize: 11, fontWeight: '600' },
  tpSlRow: { flexDirection: 'row', gap: 12, marginTop: 12, alignItems: 'center' },
  tpSlToggle: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, justifyContent: 'center', borderRadius: 10, borderWidth: 1, borderColor: colors.border.primary, backgroundColor: colors.background.tertiary },
  tpSlToggleText: { color: colors.text.secondary, fontSize: 12, fontWeight: '800' },
  positionAction: { color: colors.accent.gold, fontSize: 12, fontWeight: '800' },
  transferButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 16,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.accent.gold,
    backgroundColor: `${colors.accent.gold}15`,
  },
  transferButtonDisabled: {
    borderColor: colors.border.primary,
    backgroundColor: `${colors.text.tertiary}10`,
    opacity: 0.55,
  },
  transferButtonText: {
    color: colors.accent.gold,
    fontSize: 13,
    fontWeight: '800',
  },
  transferButtonTextDisabled: {
    color: colors.text.tertiary,
  },
  transferButtonLabel: {
    color: colors.accent.gold,
    fontSize: 13,
    fontWeight: '800',
    marginLeft: 2,
  },
  transferToggleRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 16,
  },
  transferToggleButton: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
    backgroundColor: colors.background.tertiary,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  transferToggleButtonActive: {
    backgroundColor: `${colors.accent.gold}25`,
    borderColor: colors.accent.gold,
  },
  transferToggleText: {
    color: colors.text.secondary,
    fontSize: 12,
    fontWeight: '800',
  },
  transferToggleTextActive: {
    color: colors.accent.gold,
  },
  transferAmountRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  transferMaxText: {
    color: colors.accent.gold,
    fontSize: 12,
    fontWeight: '800',
  },
  transferInput: {
    borderWidth: 1,
    borderColor: colors.border.primary,
    backgroundColor: colors.background.card,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    color: colors.text.primary,
    fontSize: 14,
    marginBottom: 8,
  },
  transferAvailableText: {
    color: colors.text.tertiary,
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 4,
  },
  transferWarningText: {
    color: colors.status.warning,
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 4,
  },
  dustBreakdown: {
    marginTop: 8,
    marginBottom: 8,
    padding: 12,
    borderRadius: 10,
    backgroundColor: colors.background.tertiary,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  dustBreakdownTitle: {
    color: colors.text.tertiary,
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 8,
    lineHeight: 16,
  },
  dustBreakdownRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
  },
  dustBreakdownLabel: {
    color: colors.text.secondary,
    fontSize: 11,
    fontWeight: '600',
  },
  dustBreakdownValue: {
    fontSize: 11,
    fontWeight: '700',
  },
  dustBreakdownHint: {
    color: colors.text.tertiary,
    fontSize: 10,
    fontWeight: '600',
    marginTop: 8,
    fontStyle: 'italic',
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
});
