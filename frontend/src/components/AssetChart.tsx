import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Dimensions,
  Platform,
  PanResponder,
  Modal,
  Pressable,
  StatusBar,
  KeyboardAvoidingView,
  Keyboard,
  Animated,
  AppState,
  type AppStateStatus,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { WebView } from 'react-native-webview';
import * as Haptics from 'expo-haptics';
import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system';
import { useLiveCandle } from '../providers/WebSocketProvider';
import { fetchChartCandles } from '../lib/fetchChartCandles';
import {
  isCalendarMonthInterval,
  isCalendarWeekInterval,
  isCalendarBarInterval,
  utcMonthStartSec,
  utcMondayStartSec,
  calendarMonthsLookbackMs,
  calendarWeeksLookbackMs,
  foldDailyLiveIntoMonthBar,
  foldDailyLiveIntoWeekBar,
} from '../lib/calendarMonthCandles';
import { colors } from '../theme/colors';
import {
  loadIndicatorPrefs,
  saveIndicatorPrefs,
  DEFAULT_EMA_ROWS,
  DEFAULT_MA_ROWS,
  DEFAULT_RSI_ROWS,
  MA_BAND_SLOT_COUNT,
  RSI_BAND_SLOT_COUNT,
  normalizeMaBandRows,
  normalizeRsiBandRows,
  normalizeRsiBandRow,
  migrateLegacyEmaRows,
  migrateLegacyMaRows,
  DEFAULT_BOLL_CONFIG,
  normalizeBollConfig,
  DEFAULT_VWAP_CONFIG,
  normalizeVwapConfig,
  DEFAULT_SUPERTREND_CONFIG,
  normalizeSupertrendConfig,
  type BollConfig,
  type VwapConfig,
  type SupertrendConfig,
  type MaBandRow,
  type MaPriceSource,
  type RsiBandRow,
} from '../lib/indicatorPrefs';
import {
  loadChartPrefs,
  saveChartPrefs,
  getCachedChartPrefs,
  getCachedChartPrefsExact,
  applyChartPrefs,
  type MainIndicatorLineGroup,
} from '../lib/chartPrefs';
import {
  getSavedInterval,
  saveLastInterval,
  getCachedInterval,
  DEFAULT_CHART_INTERVAL,
} from '../lib/intervalPrefs';
import { loadDrawings, saveDrawings } from '../lib/drawingStorage';
import * as ScreenOrientation from 'expo-screen-orientation';
import { getHyperliquidTradingState, getOpenOrders, getUserFills } from '../lib/hyperliquid';
import { LoadingIndicator } from './LoadingSpinner';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store/appStore';
import { useDisplayCurrency } from '../providers/CurrencyProvider';
import Svg, { Line as SvgLine, Circle as SvgCircle } from 'react-native-svg';
import { LinearGradient } from 'expo-linear-gradient';

const TrendlineIcon = ({ color, size = 16 }: { color: string; size?: number }) => (
  <Svg width={size} height={size} viewBox="0 0 16 16">
    <SvgLine x1={3} y1={13} x2={13} y2={3} stroke={color} strokeWidth={1.5} />
    <SvgCircle cx={3} cy={13} r={1.5} fill={color} />
    <SvgCircle cx={13} cy={3} r={1.5} fill={color} />
  </Svg>
);

const MeasureIcon = ({ color, size = 16 }: { color: string; size?: number }) => (
  <Svg width={size} height={size} viewBox="0 0 16 16">
    <SvgLine x1={2} y1={3} x2={14} y2={3} stroke={color} strokeWidth={1.5} />
    <SvgLine x1={2} y1={13} x2={14} y2={13} stroke={color} strokeWidth={1.5} />
    <SvgLine x1={8} y1={3} x2={8} y2={13} stroke={color} strokeWidth={1} strokeDasharray="2,2" />
  </Svg>
);

const FiboIcon = ({ color, size = 16 }: { color: string; size?: number }) => (
  <Svg width={size} height={size} viewBox="0 0 16 16">
    <SvgLine x1={2} y1={2} x2={14} y2={2} stroke={color} strokeWidth={1} />
    <SvgLine x1={2} y1={5.5} x2={14} y2={5.5} stroke={color} strokeWidth={1} opacity={0.7} />
    <SvgLine x1={2} y1={8} x2={14} y2={8} stroke={color} strokeWidth={1} opacity={0.5} />
    <SvgLine x1={2} y1={11} x2={14} y2={11} stroke={color} strokeWidth={1} opacity={0.7} />
    <SvgLine x1={2} y1={14} x2={14} y2={14} stroke={color} strokeWidth={1} />
  </Svg>
);

const HorizontalIcon = ({ color, size = 16 }: { color: string; size?: number }) => (
  <Svg width={size} height={size} viewBox="0 0 16 16">
    <SvgLine x1={2} y1={8} x2={14} y2={8} stroke={color} strokeWidth={1.5} />
    <SvgCircle cx={8} cy={8} r={1.5} fill={color} />
  </Svg>
);

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const CHART_HEIGHT = 250;
const CHART_PADDING = 16;
const SUB_PANE_HEIGHT = 64;
const SUB_PANE_GAP = 8;
const INLINE_CHART_TOTAL_HEIGHT = CHART_HEIGHT + SUB_PANE_HEIGHT + SUB_PANE_GAP;
// Chart recovery / watchdog timing. See `armSettleWatchdog` for the full
// flow — tl;dr: soft retry at SETTLE_SOFT_MS, hard remount at +SETTLE_HARD_MS,
// error UI after MAX_HARD_REMOUNTS. DATA_STUCK_MS kicks React Query when
// the candles fetch itself is wedged in-flight (no data to render yet).
const SETTLE_SOFT_MS = 3500;
const SETTLE_HARD_MS = 2500;
const MAX_HARD_REMOUNTS = 2;
const DATA_STUCK_MS = 8000;

const primaryIntervalsDefault = ['15m', '1h', '4h', '1d'];
const secondaryIntervals = ['1m', '3m', '5m', '30m', '2h', '8h', '12h', '3d', '1w', '1M'];
const allIntervals = Array.from(new Set([...primaryIntervalsDefault, ...secondaryIntervals]));

const defaultChartSettings = {
  useUtc: false,  // Default to local timezone
  showOrderLines: true,
  showHighLow: true,
  showOhlcvHud: true,
  showTradeMarkers: false,
  showIndValues: false,
  mainIndicatorLineVisibility: {} as Partial<Record<MainIndicatorLineGroup, boolean>>,
  drawingEnabled: false,
  primaryIntervals: primaryIntervalsDefault,
  chartMode: 'candle' as 'candle' | 'line',
};

type LightweightCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trades?: number;
};

/**
 * LWC `setData` throws (blank chart) unless times are unique and ascending.
 * Some HL snapshots emit two restated bars on the same `t` — ZEC `3d` has
 * two such pairs in the 2025-01 backfill — so interval reload of that
 * series dies while other coins' 3d charts stay fine.
 */
function sortAndCollapseCandleTimes(candles: LightweightCandle[]): LightweightCandle[] {
  if (candles.length < 2) return candles;
  const sorted = candles.slice().sort((a, b) => a.time - b.time);
  const out: LightweightCandle[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const curr = sorted[i];
    const prev = out[out.length - 1];
    if (prev.time === curr.time) {
      out[out.length - 1] = {
        time: curr.time,
        open: prev.open,
        high: Math.max(prev.high, curr.high),
        low: Math.min(prev.low, curr.low),
        close: curr.close,
        volume: curr.volume,
        trades: curr.trades ?? prev.trades,
      };
    } else {
      out.push(curr);
    }
  }
  return out;
}

const BOLL_LINE_STYLE_OPTIONS: { id: 0 | 1 | 2 | 3 | 4; labelKey: string }[] = [
  { id: 0, labelKey: 'trading.lineStyleSolid' },
  { id: 1, labelKey: 'trading.lineStyleDotted' },
  { id: 2, labelKey: 'trading.lineStyleDashed' },
  { id: 3, labelKey: 'trading.lineStyleLargeDashed' },
  { id: 4, labelKey: 'trading.lineStyleSparseDot' },
];

const BOLL_BG_SWATCHES = [
  'rgba(100, 116, 139, 0.13)',
  'rgba(59, 130, 246, 0.15)',
  'rgba(168, 85, 247, 0.14)',
  'rgba(236, 72, 153, 0.14)',
  'rgba(34, 197, 94, 0.12)',
  'rgba(234, 179, 8, 0.14)',
];

const VWAP_LINE_WIDTH_OPTIONS = [1, 2, 3, 4] as const;

type AssetChartProps = {
  decodedCoin: string;
  assetSymbol?: string;
  /**
   * HL-compatible synthesized positions for non-perp markets (HL spot). HL's
   * `clearinghouseState.assetPositions` is perp-only, so spot balances don't
   * show up in `tradingState.positions`. The asset page builds a minimal
   * spot position object ({ coin: '@N', entryPx, szi, markPx }) from the
   * fills-based cost basis and passes it here; the chart merges it into
   * `allPositions` for entry/liq line matching.
   */
  spotPositions?: any[];
  isAuthenticated: boolean;
  /** Master wallet — chart indicator / display prefs (not book-scoped). */
  userAddress: string | null;
  /**
   * Active trading book (Main or Dedicated sub). Positions, resting orders,
   * and fills follow this address. Defaults to `userAddress`.
   */
  tradingAddress?: string | null;
  /** Live book overlays from the asset page (stream-merged). Skip REST when set. */
  positions?: any[];
  openOrders?: any[];
  userFills?: any[];
  livePrice?: number | null;
  noHorizontalMargin?: boolean;
  chartId?: string;
  onInteractionChange?: (isInteracting: boolean) => void;
};

export const AssetChart = ({
  decodedCoin,
  assetSymbol,
  isAuthenticated,
  userAddress,
  tradingAddress,
  positions: positionsProp,
  openOrders: openOrdersProp,
  userFills: userFillsProp,
  livePrice,
  noHorizontalMargin = false,
  chartId,
  onInteractionChange,
  spotPositions,
}: AssetChartProps) => {
  const { t } = useTranslation();
  const tradingEnv = useAppStore((s) => s.tradingEnv);
  const { meta: cMeta, isConverted: cConverted, rates: cRates, currency: cCode } = useDisplayCurrency();
  const cRate = cRates?.[cCode] ?? 1;
  const insets = useSafeAreaInsets();
  // Seed the interval from the in-memory cache on the FIRST render of
  // every chart instance. The cache is primed at app boot from
  // `_layout.tsx` (before splash dismisses), so the very first chart
  // mount of the session also starts on the user's saved timeframe —
  // no visible '1h -> 5m' flash on cold start or symbol switches.
  const [selectedInterval, setSelectedInterval] = useState(
    () => getCachedInterval(allIntervals) ?? DEFAULT_CHART_INTERVAL,
  );
  // Tracks whether the saved last-used interval has been hydrated from
  // AsyncStorage. Until that resolves we don't persist user-driven
  // interval changes, otherwise the initial "1h" default would clobber
  // the saved value during the brief load window. Pre-seeded `true` if
  // the cache already had a valid value, since no async load is needed.
  const intervalHydratedRef = useRef(getCachedInterval(allIntervals) !== null);
  const [visibleCount, setVisibleCount] = useState(40);
  const [historyLimit, setHistoryLimit] = useState(240);
  const [historyEndTime, setHistoryEndTime] = useState(() => Date.now());
  const [isIntervalMenuOpen, setIsIntervalMenuOpen] = useState(false);
  const [isIndicatorsOpen, setIsIndicatorsOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isChartExpanded, setIsChartExpanded] = useState(false);
  const [isWebViewReady, setIsWebViewReady] = useState(false);
  const [isChartVisible, setIsChartVisible] = useState(false);
  const chartVisibleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasEverBeenReadyRef = useRef(false);
  // Tracks whether we've ever received `chart-settled` (i.e. fully
  // laid out, viewport applied, price-scale stable). Used to keep the
  // OPAQUE loading overlay up through the entire first-boot window
  // instead of switching to the 55%-translucent dim overlay at
  // `chart-ready` — otherwise the engine's brief native fit-all-bars
  // paint can bleed through during the gap between ready and settled.
  // Backed by a state flag so toggling triggers a re-render.
  const [hasEverBeenSettled, setHasEverBeenSettled] = useState(false);
  const [webViewReadyNonce, setWebViewReadyNonce] = useState(0);
  const [webViewRetryKey, setWebViewRetryKey] = useState(0);
  // Watchdog for in-place __reloadChart calls. If the WebView doesn't ack
  // (chart-settled / chart-error) within RELOAD_WATCHDOG_MS, the chart engine
  // is presumed dead and we force a real native WebView remount via
  // webViewRetryKey instead of leaving the user with a frozen chart.
  const reloadWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reloadInFlightRef = useRef(false);
  const settleWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleAwaitingRef = useRef(false);
  const hardRemountCountRef = useRef(0);
  const dataStuckWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [chartError, setChartError] = useState<string | null>(null);
  const [lwcBase64, setLwcBase64] = useState<string | null>(null);
  const lwcSource = lwcBase64 ? 'local' : 'cdn';
  const lastHistoryRequestRef = useRef(0);
  const webViewReadyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chartErrorCountRef = useRef(0);
  const lastChartErrorRef = useRef(0);
  const chartStartTime = useMemo(() => {
    return Date.UTC(2020, 0, 1);
  }, []);
  const inlineWebViewRef = useRef<WebView>(null);
  const expandedWebViewRef = useRef<WebView>(null);
  const activeWebViewModeRef = useRef<'inline' | 'expanded'>('inline');
  const lastViewportRef = useRef<{
    timeRange: { from: number; to: number } | null;
    logicalRange: { from: number; to: number } | null;
  } | null>(null);
  const [initialCandles, setInitialCandles] = useState<
    { time: number; open: number; high: number; low: number; close: number; volume: number }[] | null
  >(null);
  const lastCandleSyncRef = useRef<number | null>(null);
  const latestCandleRef = useRef<{ time: number; open: number; high: number; low: number; close: number } | null>(null);
  // Tracks the exact candles array that was baked into the WebView HTML.
  // Used to skip the post-boot __syncCandles push when it would re-send the
  // same data that's already rendered — otherwise candleSeries.setData()
  // causes a last-bar micro-wiggle right as the overlay fades.
  const bakedCandlesRef = useRef<unknown>(null);
  // Tracks the initialCandles reference that was frozen into the currently
  // mounted WebView HTML. When a freshly-mounted WebView (expanded mode,
  // containerWidth re-key, or retry) posts chart-ready, we compare this
  // against the current `initialCandles` — if they differ (e.g. user
  // switched intervals before expanding), we push __reloadChart so the
  // new WebView catches up to the current interval's dataset.
  const bakedInitialCandlesRef = useRef<unknown>(null);
  const lastLiveUpdateRef = useRef(0);
  const liveCandleRef = useRef<{ time: number; open: number; high: number; low: number; close: number; volume: number } | null>(null);
  const lastMidSyncRef = useRef<{ time: number; px: number } | null>(null);
  /** After a background pause, freeze mid/WS wick updates until REST replaces the tail. */
  const freezeLiveUntilResyncRef = useRef(false);
  const replaceTailOnNextSyncRef = useRef(false);
  const backgroundedAtRef = useRef<number | null>(null);
  const resumeUnfreezeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [earliestTimeMs, setEarliestTimeMs] = useState<number | null>(null);
  const [isSwitchingInterval, setIsSwitchingInterval] = useState(false);
  const pendingIntervalRef = useRef(selectedInterval);
  // Tracks the previously-rendered coin so the interval/coin reset
  // effect can distinguish a true coin change (different symbol = clear
  // the live-candle carry-over refs to prevent cross-symbol price
  // bleed) from an interval-only change (keep the refs so the first
  // synthesized live candle has a sensible `open` fallback).
  const prevCoinRef = useRef(decodedCoin);
  const [renderedInterval, setRenderedInterval] = useState(selectedInterval);
  const [isFetchingHistory, setIsFetchingHistory] = useState(false);
  const historyExhaustedRef = useRef(false);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [scrubX, setScrubX] = useState(0);
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);
  const [chartWidth, setChartWidth] = useState(0);
  const [containerWidth, setContainerWidth] = useState(0);
  const [indicatorState, setIndicatorState] = useState({
    emaRows: DEFAULT_EMA_ROWS,
    maRows: DEFAULT_MA_ROWS,
    rsiRows: DEFAULT_RSI_ROWS,
    boll: false,
    bollConfig: DEFAULT_BOLL_CONFIG,
    supertrend: false,
    vwap: false,
    vwapConfig: DEFAULT_VWAP_CONFIG,
    stConfig: DEFAULT_SUPERTREND_CONFIG,
    vol: false,
    rsi: false,
    cci: false,
    macd: false,
  });
  // Don't persist until AsyncStorage hydrate finishes — otherwise the
  // default indicator/settings state (written ~200ms after mount) can
  // clobber the user's saved prefs when they open/leave a chart quickly.
  const [indicatorPrefsReady, setIndicatorPrefsReady] = useState(false);
  const [chartPrefsReady, setChartPrefsReady] = useState(
    () => getCachedChartPrefsExact(userAddress) != null,
  );
  const [mainAverageTab, setMainAverageTab] = useState<'ema' | 'ma'>('ema');
  const [maColorPick, setMaColorPick] = useState<{ group: 'ema' | 'ma'; index: number } | null>(null);
  const [maSourcePick, setMaSourcePick] = useState<{ group: 'ema' | 'ma'; index: number } | null>(null);
  const [rsiColorPick, setRsiColorPick] = useState<number | null>(null);
  /** Which RSI row is editing line style (solid / dashed / …). */
  const [rsiLineStylePickIndex, setRsiLineStylePickIndex] = useState<number | null>(null);
  // Re-enable price source UI: `const [rsiSourcePick, setRsiSourcePick] = useState<number | null>(null);`
  const [isRsiModalOpen, setIsRsiModalOpen] = useState(false);
  const [isBollModalOpen, setIsBollModalOpen] = useState(false);
  const [bollColorPick, setBollColorPick] = useState<'upper' | 'mid' | 'lower' | 'background' | null>(null);
  const [bollLineStylePick, setBollLineStylePick] = useState<'upper' | 'mid' | 'lower' | null>(null);
  const [isVwapModalOpen, setIsVwapModalOpen] = useState(false);
  const [vwapColorPickOpen, setVwapColorPickOpen] = useState(false);
  const [vwapLineStylePickOpen, setVwapLineStylePickOpen] = useState(false);
  const [isStModalOpen, setIsStModalOpen] = useState(false);
  const [stColorPickOpen, setStColorPickOpen] = useState(false);
  const [stLineStylePickOpen, setStLineStylePickOpen] = useState(false);

  /** Keyboard height for bottom-anchored modals (EMA/MA, RSI) so ScrollView can pad above the keyboard. */
  const [chartModalKeyboardHeight, setChartModalKeyboardHeight] = useState(0);
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const onShow = (e: { endCoordinates: { height: number } }) =>
      setChartModalKeyboardHeight(e.endCoordinates.height);
    const onHide = () => setChartModalKeyboardHeight(0);
    const subShow = Keyboard.addListener(showEvt, onShow);
    const subHide = Keyboard.addListener(hideEvt, onHide);
    return () => {
      subShow.remove();
      subHide.remove();
    };
  }, []);

  /** Longest enabled MA/EMA/RSI period — used to size candle fetches so long lookbacks have enough bars. */
  const maxEnabledAveragePeriod = useMemo(() => {
    let m = 1;
    const scan = (rows: typeof indicatorState.emaRows) => {
      rows.forEach((r) => {
        const period = Math.round(Number(r.period));
        if (r.enabled && Number.isFinite(period) && period > 0) {
          m = Math.max(m, period);
        }
      });
    };
    scan(indicatorState.emaRows);
    scan(indicatorState.maRows);
    if (indicatorState.rsi) {
      scan(indicatorState.rsiRows);
    }
    if (indicatorState.boll) {
      const L = Math.round(Number(indicatorState.bollConfig?.length));
      /** While typing 0/1, still reserve enough bars; chart resolves length under 2 to default. */
      if (Number.isFinite(L) && L > 0) m = Math.max(m, L < 2 ? 2 : L);
    }
    if (indicatorState.vwap) {
      const L = Math.round(Number(indicatorState.vwapConfig?.length));
      if (Number.isFinite(L) && L > 0) m = Math.max(m, L < 2 ? 2 : L);
    }
    if (indicatorState.supertrend) {
      const L = Math.round(Number(indicatorState.stConfig?.period));
      if (Number.isFinite(L) && L > 0) m = Math.max(m, L);
      else if (Number.isFinite(L) && L === 0) m = Math.max(m, DEFAULT_SUPERTREND_CONFIG.period);
    }
    return m;
  }, [
    indicatorState.boll,
    indicatorState.bollConfig?.length,
    indicatorState.vwap,
    indicatorState.vwapConfig?.length,
    indicatorState.supertrend,
    indicatorState.stConfig?.period,
    indicatorState.emaRows,
    indicatorState.maRows,
    indicatorState.rsi,
    indicatorState.rsiRows,
  ]);
  const [chartSettings, setChartSettings] = useState(() => {
    const cached = getCachedChartPrefs(userAddress);
    return cached ? applyChartPrefs({ ...defaultChartSettings }, cached) : defaultChartSettings;
  });
  // Hide default chips until hydrate finishes so a long pinned set does
  // not snap over `15m 1h 4h 1d`. Cache hits paint the real set immediately.
  const intervalRowOpacity = useRef(
    new Animated.Value(getCachedChartPrefs(userAddress) != null ? 1 : 0),
  ).current;
  const intervalRowFadedInRef = useRef(getCachedChartPrefs(userAddress) != null);
  const [drawTool, setDrawTool] = useState<'trendline' | 'measure' | 'fibo' | 'horizontal' | null>('trendline');
  const [expandedDrawMode, setExpandedDrawMode] = useState(false);
  // Expanded-mode drawing tools strip is visible by default — users no
  // longer need to tap the pencil to reveal trendline/fibo. Tapping a
  // tool icon toggles its active state. The chevron collapses the strip
  // if the user wants a cleaner view.
  const [expandedToolsCollapsed, setExpandedToolsCollapsed] = useState(false);
  const savedDrawingsRef = useRef<{ start: { time: number; price: number }; end: { time: number; price: number }; tool: string; color?: string }[]>([]);

  const drawingsLoadedRef = useRef(false);
  useEffect(() => {
    if (!assetSymbol) return;
    drawingsLoadedRef.current = false;
    loadDrawings(assetSymbol).then((d) => {
      savedDrawingsRef.current = d;
      drawingsLoadedRef.current = true;
    });
  }, [assetSymbol]);

  useEffect(() => {
    if (!isChartExpanded || !isWebViewReady) return;
    const inject = () => {
      const d = savedDrawingsRef.current;
      const ref = expandedWebViewRef.current;
      if (!ref || !d || d.length === 0) return;
      ref.injectJavaScript(`(function(){try{window.__setDrawings&&window.__setDrawings(${JSON.stringify(d)});}catch(e){}return true;})();`);
    };
    const t1 = setTimeout(inject, 200);
    const t2 = setTimeout(inject, 600);
    const t3 = setTimeout(inject, 1200);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, [isChartExpanded, isWebViewReady, webViewReadyNonce]);

  const scrubTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isScrubbingRef = useRef(false);
  const lastHapticIndexRef = useRef<number | null>(null);
  const setInteracting = useCallback(
    (next: boolean) => {
      onInteractionChange?.(next);
    },
    [onInteractionChange],
  );
  const toggleChartExpanded = useCallback(() => {
    if (webViewReadyTimeoutRef.current) {
      clearTimeout(webViewReadyTimeoutRef.current);
      webViewReadyTimeoutRef.current = null;
    }
    setChartError(null);
    setIsChartExpanded((prev) => !prev);
  }, []);
  const closeExpandedChart = useCallback(() => {
    if (webViewReadyTimeoutRef.current) {
      clearTimeout(webViewReadyTimeoutRef.current);
      webViewReadyTimeoutRef.current = null;
    }
    setChartError(null);
    setExpandedDrawMode(false);
    setIsChartExpanded(false);
  }, []);

  useEffect(() => {
    activeWebViewModeRef.current = isChartExpanded ? 'expanded' : 'inline';
  }, [isChartExpanded]);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    if (isChartExpanded) {
      StatusBar.setHidden(true, 'slide');
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => {});
    } else {
      StatusBar.setHidden(false, 'slide');
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
      setExpandedDrawMode(false);
    }
    return () => {
      if (isChartExpanded) {
        StatusBar.setHidden(false, 'slide');
        ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
      }
    };
  }, [isChartExpanded]);

  const expandedSidebarPosition = useMemo(() => {
    const top = Math.max(8, insets.top + 4);
    const edgePad = 12;
    const insetPad = 8;
    return { top, left: Math.max(edgePad, insets.left + insetPad) };
  }, [insets.left, insets.top]);

  const effectiveHistoryLimit = useMemo(() => {
    const MIN_FOR_EMA200 = 220;
    const limits: Record<string, number> = {
      '1m': 480,
      '3m': 400,
      '5m': 320,
      '15m': 320,
      '30m': 240,
      '1h': 240,
      '2h': 240,
      '4h': 240,
      '8h': 240,
      '12h': 240,
      '1d': 240,
      '3d': 240,
      '1w': 240,
      '1M': 240,
    };
    const base = Math.max(MIN_FOR_EMA200, limits[selectedInterval] ?? 240);
    const indicatorBars = maxEnabledAveragePeriod + 60;
    return Math.min(2500, Math.max(base, indicatorBars));
  }, [selectedInterval, maxEnabledAveragePeriod]);

  const historyStep = useMemo(() => {
    const steps: Record<string, number> = {
      '1m': 360,
      '3m': 300,
      '5m': 240,
      '15m': 240,
      '30m': 200,
      '1h': 200,
      '2h': 160,
      '4h': 140,
      '8h': 120,
      '12h': 100,
      '1d': 80,
      '3d': 60,
      '1w': 60,
      '1M': 60,
    };
    return steps[selectedInterval] ?? 120;
  }, [selectedInterval]);

  const intervalMsMap = useMemo(
    () =>
      ({
      '1m': 60000,
      '3m': 180000,
      '5m': 300000,
      '15m': 900000,
      '30m': 1800000,
      '1h': 3600000,
      '2h': 7200000,
      '4h': 14400000,
      '8h': 28800000,
      '12h': 43200000,
      '1d': 86400000,
      '3d': 259200000,
      '1w': 604800000,
      // 1w is Monday-UTC on chart (built from 1d); 7d is still the bar step.
      // 1M is calendar-month on chart (built from 1d); use ~31d for sort/refetch heuristics only.
      '1M': 31 * 86_400_000,
    } as Record<string, number>),
    [],
  );
  const intervalMsValue = intervalMsMap[selectedInterval] ?? 3600000;
  const liveCandleFeedInterval = useMemo(
    () => (isCalendarBarInterval(selectedInterval) ? '1d' : selectedInterval),
    [selectedInterval],
  );
  const sortedIntervals = useMemo(() => {
    return [...allIntervals].sort((a, b) => (intervalMsMap[a] ?? 1e12) - (intervalMsMap[b] ?? 1e12));
  }, [intervalMsMap]);

  useEffect(() => {
    setHistoryLimit(effectiveHistoryLimit);
  }, [effectiveHistoryLimit]);

  useEffect(() => {
    // Interval/coin change invalidates the previously-captured viewport.
    // Applying a logical/time range from the old series onto a freshly-mounted
    // chart (different cadence and price range) causes a visible horizontal
    // jump right after the dim overlay fades — the HTML already runs
    // applyDefaultMainViewport() on mount, which is what we want here.
    lastViewportRef.current = null;
    // Coin-change ONLY: clear all carry-over candle refs from the
    // previous symbol. mergeLiveCandle() at the candle-arrival site
    // merges liveCandleRef into the new history's last bar whenever
    // their `time` matches — but on coin change the two symbols share
    // the same time bucket on every interval, so e.g. MSTR's $159 low
    // would silently leak into BTC's last bar as a giant wick. Same
    // hazard for latestCandleRef (used as the next live candle's open
    // fallback). Interval-only changes still skip this reset because
    // clearing there made the first synthesized live-price candle come
    // out as a flat doji.
    if (prevCoinRef.current !== decodedCoin) {
      prevCoinRef.current = decodedCoin;
      latestCandleRef.current = null;
      liveCandleRef.current = null;
      lastCandleSyncRef.current = null;
    }
    if (pendingIntervalRef.current !== selectedInterval) {
      pendingIntervalRef.current = selectedInterval;
      setIsSwitchingInterval(true);
    } else {
      setInitialCandles(null);
      setRenderedInterval(selectedInterval);
    }
    setEarliestTimeMs(null);
    setHistoryEndTime(Date.now());
    historyExhaustedRef.current = false;
  }, [decodedCoin, selectedInterval]);

  // Hydrate the last-used interval from storage. Belt-and-suspenders for
  // the case where the cache wasn't primed at app boot (web, dev hot
  // reload, etc). Runs once on mount; the cache layer dedupes if the
  // value matches what the lazy initializer already picked up.
  useEffect(() => {
    let isActive = true;
    (async () => {
      const saved = await getSavedInterval(allIntervals);
      if (!isActive) return;
      if (saved !== selectedInterval) {
        setSelectedInterval(saved);
      }
      intervalHydratedRef.current = true;
    })();
    return () => {
      isActive = false;
    };
    // Only run once on mount; re-running on every selectedInterval
    // change would fight the user's manual switches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the last-used interval after the initial hydration completes.
  // Skipping the pre-hydration window prevents the default '1h' from
  // overwriting whatever the user had saved before AsyncStorage replies.
  useEffect(() => {
    if (!intervalHydratedRef.current) return;
    saveLastInterval(selectedInterval);
  }, [selectedInterval]);

  useEffect(() => {
    let isActive = true;
    setIndicatorPrefsReady(false);
    (async () => {
      const prefs = await loadIndicatorPrefs(userAddress);
      if (!isActive) return;
      if (prefs) {
        setIndicatorState((prev) => ({
          ...prev,
          emaRows: prefs.emaRows
            ? normalizeMaBandRows(prefs.emaRows, DEFAULT_EMA_ROWS)
            : migrateLegacyEmaRows(prefs.ema as Record<number, boolean> | undefined),
          maRows: prefs.maRows
            ? normalizeMaBandRows(prefs.maRows, DEFAULT_MA_ROWS)
            : migrateLegacyMaRows(prefs.ma as Record<number, boolean> | undefined),
          rsiRows: prefs.rsiRows
            ? normalizeRsiBandRows(prefs.rsiRows, DEFAULT_RSI_ROWS)
            : normalizeRsiBandRows(prev.rsiRows, DEFAULT_RSI_ROWS),
          boll: prefs.boll ?? prev.boll,
          bollConfig: normalizeBollConfig(prefs.bollConfig ?? prev.bollConfig),
          supertrend: prefs.supertrend ?? prev.supertrend,
          stConfig: normalizeSupertrendConfig(prefs.stConfig ?? prev.stConfig),
          vwap: prefs.vwap ?? prev.vwap,
          vwapConfig: normalizeVwapConfig(prefs.vwapConfig ?? prev.vwapConfig),
          rsi: prefs.rsi ?? prev.rsi,
          vol: prefs.vol ?? prev.vol,
          cci: prefs.cci ?? prev.cci,
          macd: prefs.macd ?? prev.macd,
        }));
      }
      setIndicatorPrefsReady(true);
    })();
    return () => {
      isActive = false;
    };
  }, [userAddress]);

  useEffect(() => {
    let isActive = true;
    (async () => {
      try {
        const asset = Asset.fromModule(require('../../assets/lightweight-charts.standalone.production.js'));
        await asset.downloadAsync();
        const uri = asset.localUri || asset.uri;
        if (!uri) throw new Error('Missing asset uri');
        const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
        const normalized = base64 ? base64.replace(/\s+/g, '') : null;
        if (isActive) setLwcBase64(normalized || null);
      } catch {
        if (isActive) setLwcBase64(null);
      }
    })();
    return () => {
      isActive = false;
    };
  }, []);

  useEffect(() => {
    let isActive = true;
    const cached = getCachedChartPrefsExact(userAddress) ?? getCachedChartPrefs(userAddress);
    if (cached) {
      setChartSettings((prev) => applyChartPrefs(prev, cached));
    }
    (async () => {
      const prefs = await loadChartPrefs(userAddress);
      if (!isActive) return;
      if (prefs) {
        setChartSettings((prev) => applyChartPrefs(prev, prefs));
      }
      setChartPrefsReady(true);
    })();
    return () => {
      isActive = false;
    };
  }, [userAddress]);

  useEffect(() => {
    if (!chartPrefsReady || intervalRowFadedInRef.current) return;
    intervalRowFadedInRef.current = true;
    Animated.timing(intervalRowOpacity, {
      toValue: 1,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [chartPrefsReady, intervalRowOpacity]);

  useEffect(() => {
    if (!indicatorPrefsReady) return;
    const id = setTimeout(() => {
      saveIndicatorPrefs(userAddress, indicatorState);
    }, 200);
    return () => clearTimeout(id);
  }, [indicatorState, userAddress, indicatorPrefsReady]);

  useEffect(() => {
    if (!isIndicatorsOpen) {
      setMaColorPick(null);
      setMaSourcePick(null);
      setRsiColorPick(null);
      Keyboard.dismiss();
    }
  }, [isIndicatorsOpen]);

  useEffect(() => {
    if (!isBollModalOpen) {
      setBollColorPick(null);
      setBollLineStylePick(null);
      Keyboard.dismiss();
    }
  }, [isBollModalOpen]);

  useEffect(() => {
    if (!isVwapModalOpen) {
      setVwapColorPickOpen(false);
      setVwapLineStylePickOpen(false);
      Keyboard.dismiss();
    }
  }, [isVwapModalOpen]);

  useEffect(() => {
    if (!isStModalOpen) {
      setStColorPickOpen(false);
      setStLineStylePickOpen(false);
      Keyboard.dismiss();
    }
  }, [isStModalOpen]);

  useEffect(() => {
    if (!isRsiModalOpen) {
      setRsiColorPick(null);
      setRsiLineStylePickIndex(null);
      Keyboard.dismiss();
    }
  }, [isRsiModalOpen]);

  useEffect(() => {
    if (!chartPrefsReady) return;
    const id = setTimeout(() => {
      saveChartPrefs(userAddress, chartSettings);
    }, 200);
    return () => clearTimeout(id);
  }, [chartSettings, userAddress, chartPrefsReady]);

  const pinnedIntervals = useMemo(() => {
    const raw = Array.isArray(chartSettings.primaryIntervals) ? chartSettings.primaryIntervals : primaryIntervalsDefault;
    const uniq = Array.from(new Set(raw)).filter((i) => allIntervals.includes(i));
    const sorted = uniq.sort((a, b) => (intervalMsMap[a] ?? 1e12) - (intervalMsMap[b] ?? 1e12));
    return sorted.length ? sorted : primaryIntervalsDefault;
  }, [chartSettings.primaryIntervals]);

  const handleIntervalChange = useCallback((interval: string) => {
    if (Platform.OS !== 'web') {
      Haptics.selectionAsync();
    }
    setSelectedInterval(interval);
    setIsIntervalMenuOpen(false);
  }, []);

  const togglePinnedInterval = useCallback((interval: string) => {
    setChartSettings((prev) => {
      const current = Array.isArray(prev.primaryIntervals) ? prev.primaryIntervals : primaryIntervalsDefault;
      const has = current.includes(interval);
      if (has) {
        const next = current.filter((i) => i !== interval);
        // Never allow empty pinned list
        return { ...prev, primaryIntervals: next.length ? next : primaryIntervalsDefault };
      }
      return { ...prev, primaryIntervals: [...current, interval] };
    });
  }, []);

  const handleIntervalMenuPress = useCallback((interval: string) => {
    togglePinnedInterval(interval);
  }, [togglePinnedInterval]);

  const liveCandle = useLiveCandle(decodedCoin, liveCandleFeedInterval);
  const lastLiveCandleAtRef = useRef<number | null>(null);
  const lastSyncTimeRef = useRef<number>(Date.now());
  useEffect(() => {
    if (!liveCandle) return;
    lastLiveCandleAtRef.current = Date.now();
  }, [liveCandle]);
  const shouldRefetchCandles = !liveCandle;
  const { data: candleData, isLoading: candlesLoading, isPlaceholderData, refetch: refetchCandles } = useQuery({
    queryKey: [
      'candles',
      decodedCoin,
      selectedInterval,
      isCalendarMonthInterval(selectedInterval)
        ? 'utc-month'
        : isCalendarWeekInterval(selectedInterval)
          ? 'utc-week'
          : 'hl',
      historyLimit,
      historyEndTime,
    ],
    queryFn: () => fetchChartCandles(decodedCoin, selectedInterval, historyLimit, undefined, historyEndTime),
    enabled: !!decodedCoin,
    placeholderData: keepPreviousData,
    refetchInterval: shouldRefetchCandles ? (intervalMsValue || 60000) : false,
    refetchIntervalInBackground: true,
    // `historyEndTime` rotates every ~2 intervals, orphaning the previous
    // cache entry (a 240-2500 bar array). Default 5-min gc let several of
    // those pile up per coin/interval over a long session — free them fast.
    // 60s is still plenty for keepPreviousData to bridge key changes.
    gcTime: 60_000,
  });
  
  // Periodic sync: Even with healthy WebSocket, re-fetch from API every 2 intervals
  // This ensures local candle data doesn't drift from server over long sessions
  useEffect(() => {
    const interval = intervalMsValue || 60000;
    const syncIntervalMs = interval * 2; // Sync every 2 candles (e.g., every 2 min for 1m chart)
    
    const syncTimer = setInterval(() => {
      const now = Date.now();
      if (now - lastSyncTimeRef.current >= syncIntervalMs) {
        lastSyncTimeRef.current = now;
        setHistoryEndTime(now); // This triggers a refetch
      }
    }, syncIntervalMs);
    
    return () => clearInterval(syncTimer);
  }, [intervalMsValue]);
  
  // Keep historyEndTime moving so new candles can roll over (avoid refresh spam when live WS is healthy)
  useEffect(() => {
    const interval = intervalMsValue || 60000;
    const grace = Math.min(15000, Math.floor(interval * 0.25));
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    if (!liveCandle) {
      timeoutId = setTimeout(function tick() {
        setHistoryEndTime(Date.now());
        timeoutId = setTimeout(tick, interval);
      }, interval);
      return () => {
        if (timeoutId !== null) clearTimeout(timeoutId);
      };
    }

    const scheduleStaleCheck = () => {
      const lastLiveAt = lastLiveCandleAtRef.current ?? Date.now();
      const waitMs = Math.max(1000, interval + grace - (Date.now() - lastLiveAt));
      timeoutId = setTimeout(() => {
        const last = lastLiveCandleAtRef.current;
        const stale = last ? Date.now() - last > interval + grace : true;
        if (stale) {
          setHistoryEndTime(Date.now());
        }
      }, waitMs);
    };

    scheduleStaleCheck();
    return () => {
      if (timeoutId !== null) clearTimeout(timeoutId);
    };
  }, [intervalMsValue, liveCandle]);

  // Background pause: JS + candle WS freeze, but the first allMids tick on
  // resume is applied onto the still-open last bar (expand high/low). That
  // paints a giant wick. Interval switch "fixes" it because it reloads REST
  // without merging that live tail. Refetch and replace the tail instead.
  useEffect(() => {
    const beginPause = () => {
      if (backgroundedAtRef.current == null) backgroundedAtRef.current = Date.now();
    };
    const onChange = (next: AppStateStatus) => {
      if (next === 'background' || next === 'inactive') {
        beginPause();
        return;
      }
      if (next !== 'active') return;
      const started = backgroundedAtRef.current;
      backgroundedAtRef.current = null;
      if (!started) return;
      if (Date.now() - started < 1500) return;
      freezeLiveUntilResyncRef.current = true;
      replaceTailOnNextSyncRef.current = true;
      liveCandleRef.current = null;
      lastMidSyncRef.current = null;
      lastSyncTimeRef.current = Date.now();
      if (resumeUnfreezeTimerRef.current) clearTimeout(resumeUnfreezeTimerRef.current);
      resumeUnfreezeTimerRef.current = setTimeout(() => {
        freezeLiveUntilResyncRef.current = false;
        resumeUnfreezeTimerRef.current = null;
      }, 8000);
      setHistoryEndTime(Date.now());
    };
    const sub = AppState.addEventListener('change', onChange);
    return () => {
      sub.remove();
      if (resumeUnfreezeTimerRef.current) {
        clearTimeout(resumeUnfreezeTimerRef.current);
        resumeUnfreezeTimerRef.current = null;
      }
    };
  }, []);

  const hlAddress = (tradingAddress || userAddress || '') as string;
  const hlAddressReady = !!isAuthenticated && !!hlAddress && hlAddress.startsWith('0x');
  // Parent live overlays (asset page stream) take precedence so Dedicated
  // book switches don't keep painting Main orders until a REST refetch.
  const useLivePositions = positionsProp !== undefined;
  const useLiveOrders = openOrdersProp !== undefined;
  const useLiveFills = userFillsProp !== undefined;

  const { data: tradingState } = useQuery({
    queryKey: ['hl_trading_state', tradingEnv, hlAddress],
    queryFn: () => getHyperliquidTradingState(hlAddress as `0x${string}`),
    enabled: hlAddressReady && !useLivePositions,
    staleTime: 5_000,
    refetchInterval: 8_000,
  });

  const { data: openOrdersQuery } = useQuery({
    queryKey: ['hl_open_orders', tradingEnv, hlAddress],
    queryFn: () => getOpenOrders(hlAddress as `0x${string}`),
    enabled: hlAddressReady && !useLiveOrders,
    staleTime: 5_000,
    refetchInterval: 8_000,
  });

  /** `tradingEnv` matches asset/trade screen keys — React Query dedupes per env. */
  const { data: userFillsQuery } = useQuery({
    queryKey: ['hl_user_fills', tradingEnv, hlAddress],
    queryFn: () => getUserFills(hlAddress as `0x${string}`),
    enabled: hlAddressReady && !useLiveFills,
    staleTime: 10_000,
    refetchInterval: 30_000,
  });

  const openOrders = useLiveOrders ? openOrdersProp : openOrdersQuery;
  const userFills = useLiveFills ? userFillsProp : userFillsQuery;

  const MA_SOURCE_OPTIONS: { id: MaPriceSource; labelKey: string }[] = useMemo(
    () => [
      { id: 'open', labelKey: 'trading.maSourceOpen' },
      { id: 'high', labelKey: 'trading.maSourceHigh' },
      { id: 'low', labelKey: 'trading.maSourceLow' },
      { id: 'close', labelKey: 'trading.maSourceClose' },
      { id: 'hl2', labelKey: 'trading.maSourceHl2' },
      { id: 'ohlc4', labelKey: 'trading.maSourceOhlc4' },
    ],
    [],
  );

  const CHART_COLOR_PRESETS = useMemo(
    () => [
      colors.accent.gold,
      '#ef4444',
      '#22d3ee',
      '#a855f7',
      '#ec4899',
      '#e5e7eb',
      '#f59e0b',
      '#22c55e',
      '#60a5fa',
      '#f97316',
      '#34d399',
      '#facc15',
      '#94a3b8',
      '#ffffff',
    ],
    [],
  );

  const bollCfg = useMemo(() => normalizeBollConfig(indicatorState.bollConfig), [indicatorState.bollConfig]);
  const vwapCfg = useMemo(() => normalizeVwapConfig(indicatorState.vwapConfig), [indicatorState.vwapConfig]);
  const stCfg = useMemo(() => normalizeSupertrendConfig(indicatorState.stConfig), [indicatorState.stConfig]);

  const updateMaBandRow = useCallback((group: 'ema' | 'ma', index: number, patch: Partial<MaBandRow>) => {
    const key = group === 'ema' ? 'emaRows' : 'maRows';
    const defaults = group === 'ema' ? DEFAULT_EMA_ROWS : DEFAULT_MA_ROWS;
    setIndicatorState((prev) => {
      const rows = [...(prev as any)[key]] as MaBandRow[];
      const base = rows[index] ?? defaults[index];
      rows[index] = { ...base, ...patch };
      return { ...prev, [key]: rows };
    });
  }, []);

  const toggleMaBandEnabled = useCallback((group: 'ema' | 'ma', index: number) => {
    const key = group === 'ema' ? 'emaRows' : 'maRows';
    setIndicatorState((prev) => {
      const rows = [...(prev as any)[key]] as MaBandRow[];
      const cur = rows[index];
      if (!cur) return prev;
      rows[index] = { ...cur, enabled: !cur.enabled };
      return { ...prev, [key]: rows };
    });
  }, []);

  const setMaBandPeriodText = useCallback(
    (group: 'ema' | 'ma', index: number, text: string) => {
      const cleaned = text.replace(/[^0-9]/g, '');
      if (cleaned === '') {
        updateMaBandRow(group, index, { period: 0 });
        return;
      }
      const n = parseInt(cleaned, 10);
      if (!Number.isFinite(n)) return;
      const period = Math.max(0, Math.min(999, n));
      updateMaBandRow(group, index, { period });
    },
    [updateMaBandRow],
  );

  const updateRsiBandRow = useCallback((index: number, patch: Partial<RsiBandRow>) => {
    setIndicatorState((prev) => {
      const rows = [...prev.rsiRows];
      const def = DEFAULT_RSI_ROWS[index] ?? DEFAULT_RSI_ROWS[0];
      const base = rows[index] ?? def;
      rows[index] = normalizeRsiBandRow({ ...base, ...patch }, def);
      return { ...prev, rsiRows: rows };
    });
  }, []);

  const toggleRsiBandEnabled = useCallback((index: number) => {
    setIndicatorState((prev) => {
      const rows = [...prev.rsiRows] as RsiBandRow[];
      const cur = rows[index];
      if (!cur) return prev;
      const nextEnabled = !cur.enabled;
      rows[index] = { ...cur, enabled: nextEnabled };
      return { ...prev, rsiRows: rows, rsi: nextEnabled ? true : prev.rsi };
    });
  }, []);

  const setRsiBandPeriodText = useCallback(
    (index: number, text: string) => {
      const cleaned = text.replace(/[^0-9]/g, '');
      if (cleaned === '') {
        updateRsiBandRow(index, { period: 0 });
        return;
      }
      const n = parseInt(cleaned, 10);
      if (!Number.isFinite(n)) return;
      const period = Math.max(0, Math.min(999, n));
      updateRsiBandRow(index, { period });
    },
    [updateRsiBandRow],
  );

  const resetMainAverageTab = useCallback(() => {
    const g = mainAverageTab === 'ema' ? 'ema' : 'ma';
    setChartSettings((prev) => {
      const mv = { ...(prev.mainIndicatorLineVisibility || {}) };
      mv[g] = true;
      return { ...prev, mainIndicatorLineVisibility: mv };
    });
    if (mainAverageTab === 'ema') {
      setIndicatorState((prev) => ({
        ...prev,
        emaRows: DEFAULT_EMA_ROWS.map((r) => ({ ...r })),
      }));
    } else {
      setIndicatorState((prev) => ({
        ...prev,
        maRows: DEFAULT_MA_ROWS.map((r) => ({ ...r })),
      }));
    }
  }, [mainAverageTab]);

  /** Same as main-chart eye for EMA/MA: toggles `mainIndicatorLineVisibility` only; row checkboxes unchanged. */
  const toggleMainAverageMasterVisible = useCallback(() => {
    const g = mainAverageTab === 'ema' ? 'ema' : 'ma';
    setChartSettings((prev) => {
      const mv = { ...(prev.mainIndicatorLineVisibility || {}) };
      const curOn = mv[g] !== false;
      mv[g] = !curOn;
      return { ...prev, mainIndicatorLineVisibility: mv };
    });
  }, [mainAverageTab]);

  const resetRsiRows = useCallback(() => {
    setIndicatorState((prev) => ({
      ...prev,
      rsiRows: DEFAULT_RSI_ROWS.map((r) => ({ ...r })),
    }));
  }, []);

  const patchBollConfig = useCallback((patch: Partial<BollConfig>) => {
    setIndicatorState((prev) => ({
      ...prev,
      bollConfig: normalizeBollConfig({ ...prev.bollConfig, ...patch }),
    }));
  }, []);

  const resetBollConfigToDefault = useCallback(() => {
    setIndicatorState((prev) => ({ ...prev, bollConfig: { ...DEFAULT_BOLL_CONFIG } }));
  }, []);

  const setBollLengthText = useCallback(
    (text: string) => {
      const cleaned = text.replace(/[^0-9]/g, '');
      if (cleaned === '') {
        patchBollConfig({ length: 0 });
        return;
      }
      const n = parseInt(cleaned, 10);
      if (!Number.isFinite(n)) return;
      patchBollConfig({ length: n });
    },
    [patchBollConfig],
  );

  const setBollMultiplierText = useCallback(
    (text: string) => {
      let cleaned = text.replace(/[^0-9.]/g, '');
      const firstDot = cleaned.indexOf('.');
      if (firstDot !== -1) {
        cleaned =
          cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, '');
      }
      if (cleaned === '' || cleaned === '.') {
        patchBollConfig({ multiplier: DEFAULT_BOLL_CONFIG.multiplier });
        return;
      }
      const n = parseFloat(cleaned);
      if (!Number.isFinite(n)) return;
      patchBollConfig({ multiplier: n });
    },
    [patchBollConfig],
  );

  const patchVwapConfig = useCallback((patch: Partial<VwapConfig>) => {
    setIndicatorState((prev) => ({
      ...prev,
      vwapConfig: normalizeVwapConfig({ ...prev.vwapConfig, ...patch }),
    }));
  }, []);

  const resetVwapConfigToDefault = useCallback(() => {
    setIndicatorState((prev) => ({ ...prev, vwapConfig: { ...DEFAULT_VWAP_CONFIG } }));
  }, []);

  const setVwapLengthText = useCallback(
    (text: string) => {
      const cleaned = text.replace(/[^0-9]/g, '');
      if (cleaned === '') {
        patchVwapConfig({ length: 0 });
        return;
      }
      const n = parseInt(cleaned, 10);
      if (!Number.isFinite(n)) return;
      patchVwapConfig({ length: n });
    },
    [patchVwapConfig],
  );

  const patchStConfig = useCallback((patch: Partial<SupertrendConfig>) => {
    setIndicatorState((prev) => ({
      ...prev,
      stConfig: normalizeSupertrendConfig({ ...prev.stConfig, ...patch }),
    }));
  }, []);

  const resetStConfigToDefault = useCallback(() => {
    setIndicatorState((prev) => ({ ...prev, stConfig: { ...DEFAULT_SUPERTREND_CONFIG } }));
  }, []);

  const setStPeriodText = useCallback(
    (text: string) => {
      const cleaned = text.replace(/[^0-9]/g, '');
      if (cleaned === '') {
        patchStConfig({ period: 0 });
        return;
      }
      const n = parseInt(cleaned, 10);
      if (!Number.isFinite(n)) return;
      patchStConfig({ period: n });
    },
    [patchStConfig],
  );

  const setStMultiplierText = useCallback(
    (text: string) => {
      let cleaned = text.replace(/[^0-9.]/g, '');
      const firstDot = cleaned.indexOf('.');
      if (firstDot !== -1) {
        cleaned =
          cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, '');
      }
      if (cleaned === '' || cleaned === '.') {
        patchStConfig({ multiplier: DEFAULT_SUPERTREND_CONFIG.multiplier });
        return;
      }
      const n = parseFloat(cleaned);
      if (!Number.isFinite(n)) return;
      patchStConfig({ multiplier: n });
    },
    [patchStConfig],
  );

  const toggleRsiQuickPeriod = useCallback((period: number) => {
    setIndicatorState((prev) => {
      const rows = [...prev.rsiRows] as RsiBandRow[];
      const enabledMatches = rows
        .map((row, idx) => ({ row, idx }))
        .filter(({ row }) => row.enabled && Number(row.period) === period);
      if (enabledMatches.length) {
        enabledMatches.forEach(({ idx }) => {
          rows[idx] = { ...rows[idx], enabled: false };
        });
        return { ...prev, rsiRows: rows };
      }
      const existingIdx = rows.findIndex((row) => Number(row.period) === period);
      if (existingIdx >= 0) {
        rows[existingIdx] = { ...rows[existingIdx], enabled: true };
        return { ...prev, rsi: true, rsiRows: rows };
      }
      const targetIdx = rows.findIndex((row) => !row.enabled || Number(row.period) <= 0);
      if (targetIdx >= 0) {
        const base = rows[targetIdx] ?? DEFAULT_RSI_ROWS[targetIdx] ?? DEFAULT_RSI_ROWS[0];
        rows[targetIdx] = { ...base, period, enabled: true, source: 'close' };
        return { ...prev, rsi: true, rsiRows: rows };
      }
      if (!rows.length) {
        return {
          ...prev,
          rsi: true,
          rsiRows: [{ ...DEFAULT_RSI_ROWS[0], period, enabled: true, source: 'close' }],
        };
      }
      const replaceIdx = rows.length - 1;
      rows[replaceIdx] = { ...rows[replaceIdx], period, enabled: true, source: 'close' };
      return { ...prev, rsi: true, rsiRows: rows };
    });
  }, []);

  const addCustomRsiQuickRow = useCallback(() => {
    setIndicatorState((prev) => {
      const rows = [...prev.rsiRows] as RsiBandRow[];
      const targetCustomPeriod = 14;
      const existingEnabled = rows.some((row) => row.enabled && Number(row.period) === targetCustomPeriod);
      if (existingEnabled) return { ...prev, rsi: true };
      const existingIdx = rows.findIndex((row) => Number(row.period) === targetCustomPeriod);
      if (existingIdx >= 0) {
        rows[existingIdx] = { ...rows[existingIdx], enabled: true };
        return { ...prev, rsi: true, rsiRows: rows };
      }
      const targetIdx = rows.findIndex((row) => !row.enabled || Number(row.period) <= 0);
      if (targetIdx >= 0) {
        const base = rows[targetIdx] ?? DEFAULT_RSI_ROWS[targetIdx] ?? DEFAULT_RSI_ROWS[0];
        rows[targetIdx] = { ...base, period: targetCustomPeriod, enabled: true, source: 'close' };
        return { ...prev, rsi: true, rsiRows: rows };
      }
      if (!rows.length) {
        return {
          ...prev,
          rsi: true,
          rsiRows: [{ ...DEFAULT_RSI_ROWS[0], period: targetCustomPeriod, enabled: true, source: 'close' }],
        };
      }
      const replaceIdx = rows.length - 1;
      rows[replaceIdx] = { ...rows[replaceIdx], period: targetCustomPeriod, enabled: true, source: 'close' };
      return { ...prev, rsi: true, rsiRows: rows };
    });
  }, []);

  const SUB_PANE_KEYS = ['vol', 'macd', 'cci'] as const;

  const handleToggleSimpleIndicator = useCallback((key: 'vol' | 'macd' | 'cci') => {
    setIndicatorState((prev) => {
      const wasOn = !!(prev as any)[key];
      const subOff: Record<string, boolean> = {};
      for (const k of SUB_PANE_KEYS) subOff[k] = false;
      if (wasOn) {
        return { ...prev, ...subOff };
      }
      return { ...prev, ...subOff, [key]: true };
    });
  }, []);

  const emaActive = useMemo(() => chartSettings.mainIndicatorLineVisibility?.ema !== false && indicatorState.emaRows.some((r) => r.enabled), [indicatorState.emaRows, chartSettings.mainIndicatorLineVisibility?.ema]);
  const maActive = useMemo(() => chartSettings.mainIndicatorLineVisibility?.ma !== false && indicatorState.maRows.some((r) => r.enabled), [indicatorState.maRows, chartSettings.mainIndicatorLineVisibility?.ma]);

  const positionForCoin = useMemo(() => {
    const hlPositions = (useLivePositions ? positionsProp : tradingState?.positions) ?? [];
    const allPositions = [
      ...hlPositions,
      ...(spotPositions ?? []),
    ];
    const key = String(decodedCoin || '').toLowerCase();
    const sym = String(assetSymbol || '').toLowerCase();
    return allPositions.find((p) => {
      const c = String((p as any).coin ?? '').toLowerCase();
      return c === key || (sym && c === sym);
    });
  }, [assetSymbol, decodedCoin, tradingState?.positions, positionsProp, useLivePositions, spotPositions]);

  const limitOrdersForCoin = useMemo(() => {
    const allOrders = [...(Array.isArray(openOrders) ? openOrders : [])];
    const key = String(decodedCoin || '').toLowerCase();
    const sym = String(assetSymbol || '').toLowerCase();
    return allOrders.filter((o: any) => {
      const c = String(o?.coin ?? '').toLowerCase();
      if (!(c === key || (sym && c === sym))) return false;
      // Accept the order if it has *either* a finite limitPx (regular
      // limit) or a finite triggerPx (TP/SL trigger orders, which on
      // Hyperliquid sometimes carry limitPx=0 / null). Previously we
      // only checked limitPx, which silently dropped TP/SL lines from
      // the chart even though they existed in the orders panel. Pull
      // triggerPx from every path HL might nest it under — same chain
      // used in asset/[coin].tsx / portfolio.tsx so chart and orders
      // panel stay aligned.
      const limitFinite = Number.isFinite(parseFloat(String(o?.limitPx ?? '')));
      const triggerRaw =
        o?.triggerPx ??
        o?.trigger?.triggerPx ??
        o?.t?.trigger?.triggerPx ??
        o?.orderType?.trigger?.triggerPx ??
        null;
      const triggerFinite = Number.isFinite(parseFloat(String(triggerRaw ?? '')));
      return limitFinite || triggerFinite;
    });
  }, [assetSymbol, decodedCoin, openOrders]);

  const positionSize = useMemo(() => {
    if (!positionForCoin) return 0;
    const size = parseFloat(String((positionForCoin as any).szi ?? '0'));
    return Number.isFinite(size) ? size : 0;
  }, [positionForCoin]);

  const entryPxNum = useMemo(() => {
    if (!positionForCoin) return null;
    const entry = parseFloat(String((positionForCoin as any).entryPx ?? ''));
    return Number.isFinite(entry) ? entry : null;
  }, [positionForCoin]);

  // HL-reported liquidation price for the current position. We DON'T
  // compute this locally — Hyperliquid already accounts for
  // cross-margin pool, maintenance margin fraction, funding, and dex
  // isolation, and their number is what the matching engine will
  // actually use. Comes in as `liquidationPx` on the position object
  // (see PortfolioTabs: `p.liquidationPx`). Null / 0 / NaN = no liq
  // applicable (spot, tiny size, or infinite — e.g. fully funded).
  const liqPxNum = useMemo(() => {
    if (!positionForCoin) return null;
    const raw = (positionForCoin as any).liquidationPx;
    const liq = parseFloat(String(raw ?? ''));
    return Number.isFinite(liq) && liq > 0 ? liq : null;
  }, [positionForCoin]);

  const latestClose = useMemo(() => {
    if (Number.isFinite(livePrice ?? NaN) && (livePrice ?? 0) > 0) {
      return livePrice as number;
    }
    const candles = candleData?.candles ?? [];
    const last = candles[candles.length - 1];
    const close = parseFloat(String(last?.c ?? ''));
    return Number.isFinite(close) ? close : null;
  }, [candleData?.candles, livePrice]);

  const entryLineColor = useMemo(() => {
    if (!Number.isFinite(entryPxNum ?? NaN) || !Number.isFinite(latestClose ?? NaN)) {
      return colors.text.tertiary;
    }
    const isLong = positionSize >= 0;
    if (isLong) {
      return (latestClose as number) >= (entryPxNum as number) ? colors.status.success : colors.status.error;
    }
    return (latestClose as number) <= (entryPxNum as number) ? colors.status.success : colors.status.error;
  }, [entryPxNum, latestClose, positionSize]);

  // Classify each open order so the chart can paint its price line
  // with the right semantic color + badge:
  //   - 'tp'   → take-profit trigger: green dashed, "tp" label
  //   - 'sl'   → stop-loss trigger:   red dashed,   "sl" label
  //   - 'buy'  → plain long limit:    gold dashed, no label (color = side)
  //   - 'sell' → plain short limit:   red dashed,  no label (color = side)
  // For TP/SL orders we prefer triggerPx over limitPx since that's the
  // condition price the user actually set; HL often carries limitPx=0
  // or a wide "execution safety" px for trigger orders.
  const limitOrderLines = useMemo(() => {
    // HL surfaces TP/SL markers in different shapes depending on which
    // endpoint fed the order:
    //   1. frontendOpenOrders (REST) — what feeds openOrders here:
    //        orderType: "Take Profit Market" | "Stop Limit" | ...
    //        triggerCondition: "Take Profit" | "Stop Loss" | "N/A"
    //        isTrigger: boolean, triggerPx: string, children: [...]
    //      orderType is a *string*, not an object.
    //   2. WS orderUpdates / SDK-placed orders:
    //        o.t.trigger = { tpsl, triggerPx, isMarket }
    //      or a flat o.tpsl.
    // The previous classifier only handled shape (2), so every
    // frontendOpenOrders-sourced TP/SL fell through to side-based
    // classification — sell-side TPs and SLs all rendered as plain
    // "S" limit sells. Now we check both shapes.
    //
    // Grouped orders: when TP/SL is attached to a limit via HL's
    // positionTpsl grouping, the trigger orders live in the parent
    // order's `children` array. Top-level iteration would miss them
    // entirely — we flatten children into the rendering list so
    // every order that shows up in the portfolio panel also gets a
    // chart line.
    const classifyTpsl = (o: any): 'tp' | 'sl' | null => {
      const flat = String(o?.tpsl ?? o?.trigger?.tpsl ?? o?.t?.trigger?.tpsl ?? '').toLowerCase();
      if (flat === 'tp' || flat === 'sl') return flat as 'tp' | 'sl';
      const otRaw = o?.orderType;
      if (typeof otRaw === 'object' && otRaw) {
        const nested = String(otRaw?.trigger?.tpsl ?? '').toLowerCase();
        if (nested === 'tp' || nested === 'sl') return nested as 'tp' | 'sl';
      } else if (typeof otRaw === 'string') {
        const s = otRaw.toLowerCase();
        if (s.includes('take profit')) return 'tp';
        if (s.includes('stop')) return 'sl';
      }
      const tc = String(o?.triggerCondition ?? '').toLowerCase();
      if (tc.includes('take profit')) return 'tp';
      if (tc.includes('stop')) return 'sl';
      return null;
    };
    const readTriggerPx = (o: any): number => {
      const raw =
        o?.triggerPx ??
        o?.trigger?.triggerPx ??
        o?.t?.trigger?.triggerPx ??
        (typeof o?.orderType === 'object' ? o?.orderType?.trigger?.triggerPx : null) ??
        null;
      return parseFloat(String(raw ?? ''));
    };
    const flatOrders: any[] = [];
    limitOrdersForCoin.forEach((o: any) => {
      flatOrders.push(o);
      if (Array.isArray(o?.children)) {
        o.children.forEach((c: any) => {
          if (c) flatOrders.push(c);
        });
      }
    });
    return flatOrders
      .map((o: any) => {
        const tpsl = classifyTpsl(o);
        const triggerPxNum = readTriggerPx(o);
        const limitPxNum = parseFloat(String(o?.limitPx ?? ''));
        const isTrigger =
          tpsl !== null ||
          o?.isTrigger === true ||
          (Number.isFinite(triggerPxNum) && triggerPxNum > 0);
        const px = isTrigger && Number.isFinite(triggerPxNum) && triggerPxNum > 0
          ? triggerPxNum
          : limitPxNum;
        if (!Number.isFinite(px)) return null;
        let kind: 'tp' | 'sl' | 'buy' | 'sell';
        if (tpsl === 'tp') {
          kind = 'tp';
        } else if (tpsl === 'sl') {
          kind = 'sl';
        } else {
          const sideRaw = String(o?.side ?? o?.dir ?? o?.orderSide ?? '').toLowerCase();
          const isBuy = sideRaw === 'b' || sideRaw === 'buy' || sideRaw === 'long' || sideRaw === 'bid';
          kind = isBuy ? 'buy' : 'sell';
        }
        return { px, kind };
      })
      .filter((entry): entry is { px: number; kind: 'tp' | 'sl' | 'buy' | 'sell' } => entry !== null);
  }, [limitOrdersForCoin]);

  /** HL fills for this coin only: time + fill px for chart placement (query shared with rest of app). */
  const userFillsTradeMarkers = useMemo(() => {
    if (!userFills || !Array.isArray(userFills)) return [];
    const key = String(decodedCoin || '').toLowerCase();
    const sym = String(assetSymbol || '').toLowerCase();
    const keyTail = key.includes(':') ? key.split(':').pop() || key : key;
    const symTail = sym.includes(':') ? sym.split(':').pop() || sym : sym;
    const coinMatches = (raw: string) => {
      const c = String(raw || '').toLowerCase();
      if (!c) return false;
      if (c === key || (sym && c === sym)) return true;
      const cTail = c.includes(':') ? c.split(':').pop() || c : c;
      if (cTail && (cTail === keyTail || (!!symTail && cTail === symTail))) return true;
      return false;
    };
    const out: { t: number; buy: boolean; p?: number }[] = [];
    for (const f of userFills as any[]) {
      const c = String(f?.coin ?? f?.symbol ?? f?.asset ?? f?.market ?? '').toLowerCase();
      if (!coinMatches(c)) continue;
      const rawT = f?.time ?? f?.timestamp;
      let ms = typeof rawT === 'number' ? rawT : parseFloat(String(rawT ?? ''));
      if (!Number.isFinite(ms)) continue;
      if (ms < 1e12) ms *= 1000;
      const t = Math.floor(ms / 1000);
      const sideRaw = String(f?.side ?? f?.dir ?? f?.orderSide ?? '').toLowerCase();
      let isBuy =
        sideRaw === 'b' ||
        sideRaw === 'buy' ||
        sideRaw === 'long' ||
        sideRaw === 'bid';
      let isSell =
        sideRaw === 'a' ||
        sideRaw === 's' ||
        sideRaw === 'sell' ||
        sideRaw === 'short' ||
        sideRaw === 'ask';
      if (!isBuy && !isSell) {
        const szRaw = f?.sz ?? f?.size ?? f?.qty;
        const sz = typeof szRaw === 'number' ? szRaw : parseFloat(String(szRaw ?? ''));
        if (Number.isFinite(sz) && sz !== 0) {
          isBuy = sz > 0;
          isSell = sz < 0;
        }
      }
      if (!isBuy && !isSell) continue;
      const rawPx = f?.px ?? f?.price ?? f?.fillPx;
      const pxNum = typeof rawPx === 'number' ? rawPx : parseFloat(String(rawPx ?? ''));
      const p = Number.isFinite(pxNum) ? pxNum : undefined;
      out.push({ t, buy: isBuy, ...(p !== undefined ? { p } : {}) });
    }
    out.sort((a, b) => a.t - b.t);
    return out.slice(-80);
  }, [userFills, decodedCoin, assetSymbol]);
  const injectChartScript = useCallback(
    (body: string, scope: 'active' | 'both' = 'both') => {
      const script = `(function(){try{${body}}catch(e){}return true;})();`;
      const run = (instance: WebView | null) => {
        if (!instance) return;
        instance.injectJavaScript(script);
      };
      if (scope === 'active') {
        run(isChartExpanded ? expandedWebViewRef.current : inlineWebViewRef.current);
        return;
      }
      run(inlineWebViewRef.current);
      run(expandedWebViewRef.current);
    },
    [isChartExpanded],
  );
  const prevOverlayScopeRef = useRef<{ env: string; coin: string } | null>(null);
  useEffect(() => {
    if (!isWebViewReady) return;
    const coinKey = `${decodedCoin}|${assetSymbol ?? ''}`;
    const next = { env: tradingEnv, coin: coinKey };
    const prev = prevOverlayScopeRef.current;
    if (prev && (prev.env !== next.env || prev.coin !== next.coin)) {
      const emptyOrder = JSON.stringify({
        entryPx: null,
        entryColor: colors.text.tertiary,
        liqPx: null,
        limitOrders: [],
      });
      injectChartScript(`window.__setOrderLines && window.__setOrderLines(${emptyOrder});`, 'both');
      const tm = JSON.stringify({
        show: chartSettings.showTradeMarkers === true,
        markers: [],
      });
      injectChartScript(`window.__setTradeMarkers && window.__setTradeMarkers(${tm});`, 'both');
    }
    prevOverlayScopeRef.current = next;
  }, [assetSymbol, decodedCoin, injectChartScript, isWebViewReady, tradingEnv]);
  // Cancel any pending settle watchdog (call on chart-settled, chart-error,
  // coin/key change, or unmount).
  const clearSettleWatchdog = useCallback(() => {
    if (settleWatchdogRef.current) {
      clearTimeout(settleWatchdogRef.current);
      settleWatchdogRef.current = null;
    }
    settleAwaitingRef.current = false;
  }, []);
  // Two-phase watchdog: soft recovery first, hard remount if that fails,
  // surface error UI if even the hard path is exhausted. Used for both
  // cold boot (after chart-ready) and in-place reloads (after __reloadChart).
  const armSettleWatchdog = useCallback(
    (phase: 'cold-boot' | 'reload') => {
      clearSettleWatchdog();
      settleAwaitingRef.current = true;
      settleWatchdogRef.current = setTimeout(() => {
        settleWatchdogRef.current = null;
        if (!settleAwaitingRef.current) return;
        // Tier 1 expired — try a soft recovery by re-pushing current
        // candles. Only meaningful if we actually have data to push;
        // otherwise the data-stuck watchdog will kick the query.
        const candles = initialCandles;
        if (candles && (candles as any[]).length > 0) {
          console.warn(`[Chart] settle watchdog (${phase}) soft-recovery: re-injecting __reloadChart`);
          const payload = JSON.stringify(candles);
          injectChartScript(`window.__reloadChart && window.__reloadChart(${payload});`, 'both');
        } else {
          console.warn(`[Chart] settle watchdog (${phase}) soft-recovery skipped: no candles yet`);
        }
        // Tier 2: if still no settle after SETTLE_HARD_MS, force a real
        // native WebView remount (capped).
        settleWatchdogRef.current = setTimeout(() => {
          settleWatchdogRef.current = null;
          if (!settleAwaitingRef.current) return;
          settleAwaitingRef.current = false;
          reloadInFlightRef.current = false;
          if (reloadWatchdogRef.current) {
            clearTimeout(reloadWatchdogRef.current);
            reloadWatchdogRef.current = null;
          }
          if (hardRemountCountRef.current >= MAX_HARD_REMOUNTS) {
            console.warn(`[Chart] settle watchdog (${phase}) hard-remount cap reached — surfacing error UI`);
            setChartError(`Chart failed to load (${lwcSource})`);
            return;
          }
          hardRemountCountRef.current += 1;
          console.warn(
            `[Chart] settle watchdog (${phase}) hard-remount #${hardRemountCountRef.current}`,
          );
          setIsWebViewReady(false);
          setIsChartVisible(false);
          setMountedChartHtml(null);
          mountedChartHtmlKeyRef.current = null;
          setWebViewRetryKey((k) => k + 1);
        }, SETTLE_HARD_MS);
      }, SETTLE_SOFT_MS);
    },
    [clearSettleWatchdog, initialCandles, injectChartScript, lwcSource],
  );
  const injectWebViewRuntimeState = useCallback(() => {
    const indicatorsPayload = JSON.stringify(indicatorState);
    const effectiveSettings = {
      ...chartSettings,
      drawingEnabled: isChartExpanded && expandedDrawMode,
    };
    const settingsPayload = JSON.stringify(effectiveSettings);
    const drawToolPayload = JSON.stringify(drawTool);
    const orderPayload = JSON.stringify({
      entryPx: entryPxNum,
      entryColor: entryLineColor,
      liqPx: liqPxNum,
      limitOrders: limitOrderLines,
    });
    injectChartScript(`window.__setIndicators && window.__setIndicators(${indicatorsPayload});`, 'both');
    injectChartScript(`window.__setChartSettings && window.__setChartSettings(${settingsPayload});`, 'both');
    injectChartScript(`window.__setDrawTool && window.__setDrawTool(${drawToolPayload});`, 'both');
    injectChartScript(`window.__setOrderLines && window.__setOrderLines(${orderPayload});`, 'both');
  }, [chartSettings, drawTool, entryLineColor, entryPxNum, expandedDrawMode, indicatorState, injectChartScript, isChartExpanded, limitOrderLines, liqPxNum]);

  useEffect(() => {
    if (!isWebViewReady) return;
    const payload = JSON.stringify({
      show: chartSettings.showTradeMarkers === true,
      markers: userFillsTradeMarkers,
    });
    injectChartScript(`window.__setTradeMarkers && window.__setTradeMarkers(${payload});`, 'both');
  }, [chartSettings.showTradeMarkers, userFillsTradeMarkers, injectChartScript, isWebViewReady, webViewReadyNonce]);
  // Keep a ref so the mode-switch effect always calls the latest version
  // WITHOUT re-firing every time order-line data changes.
  const injectWebViewRuntimeStateRef = useRef(injectWebViewRuntimeState);
  injectWebViewRuntimeStateRef.current = injectWebViewRuntimeState;
  const applyStoredViewportToActive = useCallback(() => {
    const viewport = lastViewportRef.current;
    if (!viewport) return;
    const payload = JSON.stringify(viewport);
    injectChartScript(`window.__setViewport && window.__setViewport(${payload});`, 'active');
  }, [injectChartScript]);
  const applyStoredViewportRef = useRef(applyStoredViewportToActive);
  applyStoredViewportRef.current = applyStoredViewportToActive;
  // Only re-run when the chart mode actually changes (inline ↔ expanded).
  // Runtime state (indicators, order lines, etc.) is handled by dedicated effects below.
  useEffect(() => {
    setIsWebViewReady(false);
    setIsChartVisible(false);
    if (chartVisibleTimerRef.current) { clearTimeout(chartVisibleTimerRef.current); chartVisibleTimerRef.current = null; }
    const sync = () => {
      injectWebViewRuntimeStateRef.current();
      applyStoredViewportRef.current();
    };
    const t0 = setTimeout(sync, 0);
    const t1 = setTimeout(sync, 120);
    const t2 = setTimeout(sync, 300);
    const timers = [t0, t1, t2];
    if (isChartExpanded) {
      const injectDrawings = () => {
        const d = savedDrawingsRef.current;
        const ref = expandedWebViewRef.current;
        if (!ref) return;
        if (!drawingsLoadedRef.current) return;
        if (d && d.length > 0) {
          ref.injectJavaScript(`(function(){try{window.__setDrawings&&window.__setDrawings(${JSON.stringify(d)});}catch(e){}return true;})();`);
        }
      };
      timers.push(setTimeout(injectDrawings, 500));
      timers.push(setTimeout(injectDrawings, 1200));
      timers.push(setTimeout(injectDrawings, 2500));
    }
    return () => { timers.forEach(clearTimeout); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isChartExpanded]);

  const normalizeCandleTime = useCallback((raw: any) => {
    const num = Number(raw);
    if (!Number.isFinite(num)) return null;
    if (num > 1e12) return Math.floor(num / 1000);
    if (num > 1e10) return Math.floor(num / 1000);
    return Math.floor(num);
  }, []);
  const normalizeViewportRange = useCallback((range: any) => {
    if (!range || range.from === null || range.from === undefined || range.to === null || range.to === undefined) {
      return null;
    }
    const from = Number(range.from);
    const to = Number(range.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
    return { from, to };
  }, []);

  const mapToLightweightCandles = useCallback((candles: any[]) => {
    if (!Array.isArray(candles)) return [];
    const mapped = candles
      .map((c) => {
        const time = normalizeCandleTime((c as any)?.t ?? (c as any)?.time ?? (c as any)?.timestamp);
        const open = parseFloat(String(c.o));
        const high = parseFloat(String(c.h));
        const low = parseFloat(String(c.l));
        const close = parseFloat(String(c.c));
        const volume = parseFloat(String((c as any)?.v ?? '0'));
        // `trades` (N, number of trades in bar) comes straight from
        // Hyperliquid's candle format. Preserved end-to-end so the
        // crosshair HUD can show it without any extra subscription.
        const tradesRaw = (c as any)?.n ?? (c as any)?.trades;
        const trades = tradesRaw != null ? Number(tradesRaw) : undefined;
        if (!Number.isFinite(time ?? NaN) || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
          return null;
        }
        return {
          time,
          open,
          high,
          low,
          close,
          volume: Number.isFinite(volume) ? volume : 0,
          trades: Number.isFinite(trades as number) ? (trades as number) : undefined,
        };
      })
      .filter(Boolean) as LightweightCandle[];
    const unique = sortAndCollapseCandleTimes(mapped);
    if (unique.length < 2) return unique;
    // Calendar months/weeks are not HL's fixed 30d / Thursday 1w grid — don't insert those synthetics.
    if (isCalendarBarInterval(selectedInterval)) return unique;
    const stepSec = Math.round(intervalMsValue / 1000);
    if (stepSec <= 0) return unique;
    const filled: LightweightCandle[] = [unique[0]];
    const MAX_FILL_PER_GAP = 500;
    for (let i = 1; i < unique.length; i++) {
      const prev = unique[i - 1];
      const curr = unique[i];
      const gap = curr.time - prev.time;
      const missing = Math.round(gap / stepSec) - 1;
      if (missing > 0 && missing <= MAX_FILL_PER_GAP) {
        const fillPrice = prev.close;
        for (let j = 1; j <= missing; j++) {
          filled.push({
            time: prev.time + stepSec * j,
            open: fillPrice,
            high: fillPrice,
            low: fillPrice,
            close: fillPrice,
            volume: 0,
          });
        }
      }
      filled.push(curr);
    }
    return filled;
  }, [normalizeCandleTime, intervalMsValue, selectedInterval]);

  const mergeLiveCandle = useCallback((candles: any[]) => {
    if (!Array.isArray(candles) || !candles.length) return candles;
    const live = liveCandleRef.current as any;
    const last = candles[candles.length - 1] as any;
    if (!live || !last || live.time !== last.time) return candles;
    const merged = {
      ...last,
      high: Math.max(last.high, live.high),
      low: Math.min(last.low, live.low),
      close: live.close,
      // `trades` only flows when the WS candle payload had `n`. Prefer
      // the live value (it's monotonically non-decreasing within a bar)
      // but fall back to the historical value if WS didn't include it.
      trades:
        Number.isFinite(live?.trades as number)
          ? (live.trades as number)
          : Number.isFinite(last?.trades as number)
            ? (last.trades as number)
            : undefined,
    };
    const next = candles.slice(0, -1).concat(merged);
    liveCandleRef.current = { ...live, ...merged };
    latestCandleRef.current = merged;
    return next;
  }, []);

  useEffect(() => {
    if (!candleData?.candles?.length || isPlaceholderData) return;
    if (initialCandles && !isSwitchingInterval) return;
    const mapped = mergeLiveCandle(mapToLightweightCandles(candleData.candles));
    if (!mapped.length) return;
    bakedCandlesRef.current = candleData.candles;
    // In-place reload path: if the WebView is already mounted and ready
    // for this chartKey (i.e. this is an interval change, not a cold
    // mount), push the new dataset via __reloadChart and keep the same
    // WebView alive. Avoids the 200-400ms native WebView boot + chart
    // engine init cost that used to be paid on every interval tap.
    const canReloadInPlace =
      isSwitchingInterval &&
      isWebViewReady &&
      hasEverBeenReadyRef.current &&
      renderedInterval !== selectedInterval;
    if (canReloadInPlace) {
      // Keep the dim overlay visible until the reload's chart-settled
      // message arrives (flips isChartVisible back to true). No 900ms
      // force-reveal here — the tiered settle watchdog below handles
      // stuck reloads properly (soft retry → hard remount → error UI)
      // instead of lifting the overlay onto an empty chart body.
      setIsChartVisible(false);
      if (chartVisibleTimerRef.current) { clearTimeout(chartVisibleTimerRef.current); chartVisibleTimerRef.current = null; }
      const reloadPayload = JSON.stringify(mapped);
      injectChartScript(`window.__reloadChart && window.__reloadChart(${reloadPayload});`, 'both');
      // Tiered settle watchdog is the single source of recovery truth:
      // Tier 1 (soft, 3.5s) re-injects __reloadChart, Tier 2 (hard, +2.5s)
      // force-remounts the WebView, Tier 3 surfaces the error UI.
      // (The legacy single-phase reloadWatchdogRef used to jump straight
      // to a hard remount at 2.5s, which skipped the soft-recovery step.)
      reloadInFlightRef.current = true;
      armSettleWatchdog('reload');
    }
    setInitialCandles(mapped as any);
    setRenderedInterval(selectedInterval);
    if (isSwitchingInterval) {
      setIsSwitchingInterval(false);
      if (!canReloadInPlace) {
        // Cold boot / recovery path — full remount via chartKey + source
        // swap. This still happens on coin changes and error retries.
        setIsWebViewReady(false);
        setIsChartVisible(false);
        if (chartVisibleTimerRef.current) { clearTimeout(chartVisibleTimerRef.current); chartVisibleTimerRef.current = null; }
      }
    }
    const earliest = (mapped[0] as any)?.time;
    if (Number.isFinite(earliest)) {
      setEarliestTimeMs((earliest as number) * 1000);
    }
    const last = (mapped[mapped.length - 1] as any)?.time;
    if (Number.isFinite(last)) {
      lastCandleSyncRef.current = last as number;
    }
    const latest = (mapped[mapped.length - 1] as any);
    if (latest && Number.isFinite(latest.time)) {
      latestCandleRef.current = latest;
    }
    if (mapped.length < historyLimit * 0.5) {
      historyExhaustedRef.current = true;
    }
  }, [armSettleWatchdog, candleData?.candles, historyLimit, initialCandles, injectChartScript, isPlaceholderData, isSwitchingInterval, isWebViewReady, mapToLightweightCandles, mergeLiveCandle, renderedInterval, selectedInterval]);

  // Data-layer watchdog: if `initialCandles` is still null DATA_STUCK_MS
  // after mount (or after a coin/interval switch), the candles query is
  // likely wedged in-flight — nudge React Query to refetch so the user
  // doesn't stay on the spinner indefinitely. Low-risk: react-query dedupes
  // concurrent requests for the same queryKey.
  useEffect(() => {
    if (initialCandles && (initialCandles as any[]).length > 0) {
      if (dataStuckWatchdogRef.current) {
        clearTimeout(dataStuckWatchdogRef.current);
        dataStuckWatchdogRef.current = null;
      }
      return;
    }
    if (dataStuckWatchdogRef.current) clearTimeout(dataStuckWatchdogRef.current);
    dataStuckWatchdogRef.current = setTimeout(() => {
      dataStuckWatchdogRef.current = null;
      console.warn('[Chart] candles query appears stuck after', DATA_STUCK_MS, 'ms — forcing refetch');
      try {
        refetchCandles();
      } catch (e) {
        console.warn('[Chart] refetchCandles threw:', e);
      }
    }, DATA_STUCK_MS);
    return () => {
      if (dataStuckWatchdogRef.current) {
        clearTimeout(dataStuckWatchdogRef.current);
        dataStuckWatchdogRef.current = null;
      }
    };
  }, [decodedCoin, initialCandles, refetchCandles, selectedInterval]);

  useEffect(() => {
    if (!isWebViewReady || !initialCandles || !candleData?.candles?.length || isPlaceholderData) return;
    // Skip when the incoming candles array is the very same reference that
    // was baked into the current HTML payload. React Query returns a new
    // array reference whenever data actually changes, so this only short-
    // circuits the redundant post-boot sync and still lets genuine refetch
    // updates go through.
    if (candleData.candles === bakedCandlesRef.current) return;
    const mapped = mapToLightweightCandles(candleData.candles);
    if (!mapped.length) return;
    
    const syncWindowSize = 30;
    const cutoffIndex = Math.max(0, mapped.length - syncWindowSize);
    const nextCandles = mapped.slice(cutoffIndex);
    const replaceLatest = replaceTailOnNextSyncRef.current;
    replaceTailOnNextSyncRef.current = false;
    
    if (nextCandles.length) {
      const payload = JSON.stringify(nextCandles);
      injectChartScript(
        `window.__syncCandles && window.__syncCandles(${payload}, ${replaceLatest ? 'true' : 'false'});`,
        'both',
      );
      const last = (mapped[mapped.length - 1] as any)?.time;
      if (Number.isFinite(last)) {
        lastCandleSyncRef.current = last as number;
      }
      const latest = (mapped[mapped.length - 1] as any);
      if (latest && Number.isFinite(latest.time)) {
        latestCandleRef.current = latest;
        if (replaceLatest) {
          liveCandleRef.current = latest;
          freezeLiveUntilResyncRef.current = false;
          if (resumeUnfreezeTimerRef.current) {
            clearTimeout(resumeUnfreezeTimerRef.current);
            resumeUnfreezeTimerRef.current = null;
          }
        }
      }
    }
  }, [candleData?.candles, initialCandles, isPlaceholderData, isWebViewReady, mapToLightweightCandles]);

  useEffect(() => {
    if (!isWebViewReady || !initialCandles?.length || !liveCandle) return;
    if (freezeLiveUntilResyncRef.current) return;
    // Same rationale as the live-price effect above: wait until the first
    // settle pass is done so a WS tick landing mid-fade can't autoscale.
    if (!isChartVisible) return;
    // Don't push a WS live-candle into a chart whose interval we're mid-way
    // through switching away from — the tick's bucket time is for the
    // already-selected new interval and would land on an off-grid time in
    // the still-mounted previous-interval chart.
    if (renderedInterval !== selectedInterval || isSwitchingInterval) return;
    const time = normalizeCandleTime((liveCandle as any)?.t ?? (liveCandle as any)?.time ?? (liveCandle as any)?.timestamp);
    const open = parseFloat(String((liveCandle as any)?.o ?? (liveCandle as any)?.open ?? ''));
    const high = parseFloat(String((liveCandle as any)?.h ?? (liveCandle as any)?.high ?? ''));
    const low = parseFloat(String((liveCandle as any)?.l ?? (liveCandle as any)?.low ?? ''));
    const close = parseFloat(String((liveCandle as any)?.c ?? (liveCandle as any)?.close ?? ''));
    const volume = parseFloat(String((liveCandle as any)?.v ?? (liveCandle as any)?.volume ?? '0'));
    const tradesRaw = (liveCandle as any)?.n ?? (liveCandle as any)?.trades;
    const trades = tradesRaw != null ? Number(tradesRaw) : undefined;
    if (!Number.isFinite(time ?? NaN) || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
      return;
    }
    let nextCandle = {
      time: time as number,
      open,
      high,
      low,
      close,
      volume: Number.isFinite(volume) ? volume : 0,
      trades: Number.isFinite(trades as number) ? (trades as number) : undefined,
    } as any;
    if (isCalendarMonthInterval(selectedInterval) || isCalendarWeekInterval(selectedInterval)) {
      const bucketStart = isCalendarMonthInterval(selectedInterval)
        ? utcMonthStartSec(time as number)
        : utcMondayStartSec(time as number);
      const seed =
        (liveCandleRef.current as any)?.time === bucketStart
          ? (liveCandleRef.current as any)
          : (latestCandleRef.current as any)?.time === bucketStart
            ? (latestCandleRef.current as any)
            : null;
      const dailyBar = {
        time: time as number,
        open,
        high,
        low,
        close,
        volume: Number.isFinite(volume) ? volume : 0,
        trades: Number.isFinite(trades as number) ? (trades as number) : undefined,
      };
      nextCandle = (
        isCalendarMonthInterval(selectedInterval)
          ? foldDailyLiveIntoMonthBar(dailyBar, seed)
          : foldDailyLiveIntoWeekBar(dailyBar, seed)
      ) as any;
    }
    const existing = liveCandleRef.current as any;
    if (existing && existing.time === nextCandle.time) {
      liveCandleRef.current = {
        ...existing,
        ...nextCandle,
        open: existing.open ?? nextCandle.open,
        high: Math.max(existing.high ?? nextCandle.high, nextCandle.high ?? existing.high),
        low: Math.min(existing.low ?? nextCandle.low, nextCandle.low ?? existing.low),
        close: nextCandle.close ?? existing.close,
        volume: Math.max(existing.volume ?? 0, nextCandle.volume ?? 0),
        // `trades` is monotonic within a bar, so keep the max we've seen.
        trades: Number.isFinite(nextCandle.trades)
          ? Math.max(Number(existing.trades) || 0, Number(nextCandle.trades) || 0)
          : existing.trades,
      };
    } else {
      liveCandleRef.current = nextCandle;
    }
    const last = lastCandleSyncRef.current;
    if (!Number.isFinite(last as number) || (time as number) > (last as number)) {
      lastCandleSyncRef.current = time as number;
    }
    latestCandleRef.current = liveCandleRef.current;
    const payload = JSON.stringify([liveCandleRef.current]);
    injectChartScript(`window.__appendCandles && window.__appendCandles(${payload});`, 'both');
  }, [initialCandles?.length, injectChartScript, isChartVisible, isSwitchingInterval, isWebViewReady, liveCandle, normalizeCandleTime, renderedInterval, selectedInterval]);

  // HL's candle channel only ticks on actual trades, so during quiet
  // moments the in-progress bar's close can freeze even though `allMids` (used
  // by the header price) still pushes snapshots. That's what made the chart
  // pill drift away from the header — e.g. BTC header at 77381 while the chart
  // still reads 77327 until the 1m bar closed.
  //
  // Bridge the two feeds: whenever `livePrice` moves, update the current
  // bar's close on the chart (and expand high/low if needed) to match.
  // We compute the current bar's time bucket from `Date.now()` + the active
  // interval so this works even before HL's candle WS has pushed a frame
  // for the bar. When a real trade does fire the candle WS takes over —
  // our write is idempotent (same bar.time), so we just converge.
  useEffect(() => {
    if (!isWebViewReady || !isChartVisible) return;
    if (freezeLiveUntilResyncRef.current) return;
    if (renderedInterval !== selectedInterval || isSwitchingInterval) return;
    if (!Number.isFinite(livePrice ?? NaN) || (livePrice ?? 0) <= 0) return;
    const intervalSec = Math.max(1, Math.floor((intervalMsValue || 60000) / 1000));
    const nowSec = Math.floor(Date.now() / 1000);
    const barTime = isCalendarMonthInterval(selectedInterval)
      ? utcMonthStartSec(nowSec)
      : isCalendarWeekInterval(selectedInterval)
        ? utcMondayStartSec(nowSec)
        : Math.floor(nowSec / intervalSec) * intervalSec;
    const px = livePrice as number;
    const last = lastMidSyncRef.current;
    if (last && last.time === barTime && Math.abs(last.px - px) < 1e-9) return;

    // Prefer the existing live candle (carries real OHLC from the WS) so
    // we don't flatten the open when a user is watching a fast mover; only
    // fall back to a px-based synthetic bar if no candle has arrived yet.
    const existing = liveCandleRef.current as any;
    const base =
      existing && Number.isFinite(existing.time) && existing.time === barTime
        ? existing
        : { time: barTime, open: px, high: px, low: px, close: px, volume: 0 };
    const merged = {
      ...base,
      time: barTime,
      open: Number.isFinite(base.open) ? base.open : px,
      high: Number.isFinite(base.high) ? Math.max(base.high, px) : px,
      low: Number.isFinite(base.low) ? Math.min(base.low, px) : px,
      close: px,
      volume: Number.isFinite(base.volume) ? base.volume : 0,
    };
    liveCandleRef.current = merged;
    latestCandleRef.current = merged;
    lastMidSyncRef.current = { time: barTime, px };
    const payload = JSON.stringify([merged]);
    injectChartScript(`window.__appendCandles && window.__appendCandles(${payload});`, 'both');
  }, [livePrice, injectChartScript, intervalMsValue, isChartVisible, isSwitchingInterval, isWebViewReady, renderedInterval, selectedInterval]);

  const loadMoreHistory = useCallback(async () => {
    if (!decodedCoin || isFetchingHistory) return;
    if (!earliestTimeMs || earliestTimeMs <= chartStartTime) return;
    // Don't keep trying if we've already exhausted history
    if (historyExhaustedRef.current) return;
    
    setIsFetchingHistory(true);
    const isMonth = isCalendarMonthInterval(selectedInterval);
    const isWeek = isCalendarWeekInterval(selectedInterval);
    const lookbackMs = isMonth
      ? calendarMonthsLookbackMs(historyStep)
      : isWeek
        ? calendarWeeksLookbackMs(historyStep)
        : intervalMsValue * historyStep;
    const stepMs = isMonth || isWeek ? 86_400_000 : intervalMsValue;
    const nextEnd = Math.max(chartStartTime, earliestTimeMs - stepMs);
    const nextStart = Math.max(chartStartTime, nextEnd - lookbackMs);
    try {
      const res = await fetchChartCandles(decodedCoin, selectedInterval, historyStep, nextStart, nextEnd);
      const newMapped = mapToLightweightCandles(res.candles || []);
      if (newMapped.length) {
        const earliest = (newMapped[0] as any)?.time;
        if (Number.isFinite(earliest)) {
          const newEarliestMs = (earliest as number) * 1000;
          // If the new earliest is the same or later than what we had, history is exhausted
          if (newEarliestMs >= earliestTimeMs) {
            historyExhaustedRef.current = true;
            // Notify WebView to stop requesting
            injectChartScript('window.__historyExhausted = true;', 'both');
          } else {
            setEarliestTimeMs(newEarliestMs);
          }
        }
        const payload = JSON.stringify(newMapped);
        injectChartScript(`window.__appendCandles && window.__appendCandles(${payload});`, 'both');
      } else {
        // No data returned - history is exhausted
        historyExhaustedRef.current = true;
        injectChartScript('window.__historyExhausted = true;', 'both');
      }
    } catch {
      // On error, mark as exhausted to prevent spam
      historyExhaustedRef.current = true;
    } finally {
      setIsFetchingHistory(false);
    }
  }, [chartStartTime, decodedCoin, earliestTimeMs, historyStep, injectChartScript, intervalMsValue, isFetchingHistory, mapToLightweightCandles, selectedInterval]);

  const lightweightChartHtml = useMemo(() => {
    if (!initialCandles?.length) return null;
    const payload = {
      candles: initialCandles,
      entryPx: null,
      entryColor: colors.text.tertiary,
      liqPx: null,
      limitOrders: [] as Array<{ px: number; isBuy: boolean }>,
      indicators: indicatorState,
      settings: chartSettings,
    };
    const lwcScriptTag = lwcBase64
      ? `<script src="data:text/javascript;base64,${lwcBase64}"></script>`
      : `<script src="https://unpkg.com/lightweight-charts@4.1.1/dist/lightweight-charts.standalone.production.js"></script>`;
    return `<!doctype html>
<html dir="ltr">
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0" />
    <style>
      html, body, #chart-root { margin: 0; padding: 0; width: 100%; height: 100%; min-height: 100%; background: ${colors.background.primary}; }
      html, body { direction: ltr; }
      body { overflow: hidden; }
      * { -webkit-user-select: none; user-select: none; }
      #chart-root { display: flex; flex-direction: column; width: 100%; height: 100%; gap: 8px; }
      #chart-main-wrap { position: relative; width: 100%; flex: 0 0 auto; transition: height 0.15s ease-out; }
      #chart-main { width: 100%; height: 100%; }
      #chart-subs { width: 100%; display: flex; flex-direction: column; gap: 8px; flex: 0 0 auto; transition: height 0.15s ease-out, opacity 0.12s ease-out; }
      .sub-chart {
        width: 100%;
        height: ${SUB_PANE_HEIGHT}px;
        position: relative;
        border-radius: 8px;
        box-sizing: border-box;
        box-shadow: inset 0 0 0 1px ${colors.border.primary};
        background: ${colors.background.primary};
      }
      .sub-chart-label {
        position: absolute;
        top: 4px;
        left: 8px;
        z-index: 20;
        color: ${colors.text.tertiary};
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 0.3px;
        pointer-events: none;
        background: rgba(10, 10, 15, 0.75);
        border: 1px solid ${colors.border.primary};
        border-radius: 4px;
        padding: 1px 4px;
      }
      .extreme-label {
        position: absolute;
        color: ${colors.text.primary};
        font-size: 10px;
        font-weight: 700;
        /* No background / border / padding — minimal "just the number"
           look. A tight 2px black text-shadow keeps the digits readable
           over bright candle bodies without any badge chrome around
           them (same trick TradingView uses for their H/L labels). */
        text-shadow:
          0 0 2px rgba(0, 0, 0, 0.9),
          0 0 3px rgba(0, 0, 0, 0.7);
        transform: translate(-50%, -50%);
        z-index: 10;
        pointer-events: none;
        white-space: nowrap;
      }
      #trade-markers-root {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        top: 0;
        pointer-events: none;
        /* Above #draw-layer (11) and crosshair/draw handles (12); below #indicator-values (15) and #draw-confirm (30). */
        z-index: 14;
        overflow: visible;
      }
      .trade-marker {
        position: absolute;
        width: 15px;
        height: 13px;
        transform: translateX(-50%);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 8px;
        font-weight: 900;
        line-height: 1;
        color: rgba(8, 10, 14, 0.92);
        letter-spacing: 0;
        border: none;
        box-sizing: border-box;
      }
      .trade-marker-buy {
        background: ${colors.status.success};
        clip-path: polygon(50% 0%, 100% 38%, 79% 100%, 21% 100%, 0% 38%);
      }
      .trade-marker-sell {
        background: ${colors.status.error};
        clip-path: polygon(50% 100%, 100% 62%, 79% 0%, 21% 0%, 0% 62%);
      }
      #ind-toggle {
        position: absolute;
        top: 1px;
        left: 4px;
        z-index: 16;
        width: 18px;
        height: 18px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        color: ${colors.text.tertiary};
        background: rgba(10, 10, 15, 0.7);
        border-radius: 4px;
        transition: transform 0.2s ease;
        -webkit-tap-highlight-color: transparent;
      }
      #ind-toggle.open {
        transform: rotate(180deg);
      }
      #indicator-values {
        position: absolute;
        top: 1px;
        left: 24px;
        display: none;
        flex-direction: column;
        align-items: flex-start;
        gap: 4px;
        z-index: 15;
        pointer-events: none;
        font-size: 9px;
        font-weight: 600;
        max-width: calc(100% - 28px);
      }
      #indicator-values.visible {
        display: flex;
      }
      #ind-values-stack {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 4px;
        width: max-content;
        max-width: 100%;
      }
      .ind-row {
        display: inline-block;
        max-width: 100%;
        vertical-align: top;
      }
      .ind-row-pills {
        display: inline-flex;
        flex-direction: row;
        flex-wrap: wrap;
        gap: 4px;
        align-items: center;
        max-width: 100%;
        min-width: 0;
      }
      .ind-row-eye {
        flex-shrink: 0;
        width: 20px;
        height: 20px;
        padding: 0;
        margin: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        align-self: center;
        pointer-events: auto;
        cursor: pointer;
        border: none;
        border-radius: 4px;
        background: rgba(10, 10, 15, 0.65);
        color: ${colors.text.tertiary};
        -webkit-tap-highlight-color: transparent;
        opacity: 0.72;
      }
      .ind-row-eye:active { opacity: 1; }
      .ind-row-eye .ind-eye-off { display: none; }
      .ind-row-eye.off { opacity: 0.48; }
      .ind-row-eye.off .ind-eye-open { display: none; }
      .ind-row-eye.off .ind-eye-off { display: block; }
      .ind-val {
        padding: 0;
        border-radius: 0;
        background: transparent;
      }
      .ind-val-pill {
        display: inline-flex;
        flex-direction: row;
        align-items: baseline;
        gap: 4px;
        padding: 2px 5px;
        border-radius: 5px;
        background: rgba(10, 10, 15, 0.88);
        border: 1px solid ${colors.border.primary};
        box-shadow: 0 1px 0 rgba(0,0,0,0.35);
        line-height: 1.1;
      }
      .ind-val-tag {
        font-size: 8px;
        font-weight: 800;
        letter-spacing: 0.02em;
        opacity: 0.95;
        flex-shrink: 0;
      }
      .ind-val-num {
        font-size: 9px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        font-feature-settings: "tnum" 1;
        letter-spacing: 0.01em;
        white-space: nowrap;
      }
      #crosshair-dot {
        position: absolute;
        width: 8px;
        height: 8px;
        border-radius: 999px;
        border: 0;
        background: #60a5fa;
        transform: translate(-50%, -50%);
        pointer-events: none;
        opacity: 0;
        z-index: 12;
      }
      /* Future-time label: shown at the bottom of the chart when the
         crosshair is past the last candle (inside the rightOffset empty
         space). Values are copied 1:1 from LWC's native crosshair time
         axis label for this chart config: same fontFamily + 11px, same
         labelBackgroundColor (colors.background.primary), no border,
         no radius, and the text color LWC picks for this dark bg
         (white). Positioned to match the native axis label's vertical
         placement over the time axis. */
      #future-time-label {
        position: absolute;
        bottom: 0;
        padding: 2px 4px;
        background: ${colors.background.primary};
        color: #FFFFFF;
        border: 0;
        border-radius: 0;
        font-family: Inter, -apple-system, BlinkMacSystemFont, sans-serif;
        font-size: 11px;
        font-weight: 400;
        line-height: 1;
        white-space: nowrap;
        transform: translateX(-50%);
        pointer-events: none;
        opacity: 0;
        z-index: 11;
      }
      #future-time-label.visible { opacity: 1; }
      /* OHLCV HUD — minimal translucent bar shown while the crosshair
         is active over a candle. See-through so the candles behind
         remain visible (~42% bg + backdrop blur). Auto-hides when the
         crosshair leaves. Lives inside #chart-main-wrap so it scales
         with both inline and expanded (landscape) layouts.
         Font sizes kept tiny so the full O/H/L/C/Δ%/V/N row fits
         across narrow phones without truncation. Top position is
         computed dynamically in positionHud() so it sits just below
         whatever is currently painted at the top-left corner
         (ind-toggle when the indicator panel is closed, or the full
         indicator stack when it is open) — never stacked on top. */
      #ohlcv-hud {
        position: absolute;
        top: 22px;
        left: 4px;
        display: none;
        flex-direction: row;
        flex-wrap: wrap;
        align-items: center;
        column-gap: 5px;
        row-gap: 1px;
        padding: 2px 5px;
        border-radius: 5px;
        background: rgba(8, 11, 18, 0.42);
        -webkit-backdrop-filter: blur(6px);
        backdrop-filter: blur(6px);
        border: 1px solid rgba(255, 255, 255, 0.05);
        pointer-events: none;
        z-index: 13;
        font-variant-numeric: tabular-nums;
        font-feature-settings: "tnum" 1;
        line-height: 1.1;
        max-width: calc(100% - 8px);
        overflow: visible;
      }
      #ohlcv-hud.open { display: inline-flex; }
      #ohlcv-hud .hud-item { display: inline-flex; align-items: baseline; gap: 2px; }
      #ohlcv-hud .hud-k {
        font-size: 7px;
        font-weight: 700;
        letter-spacing: 0.04em;
        color: ${colors.text.tertiary};
        text-transform: uppercase;
      }
      #ohlcv-hud .hud-v {
        font-size: 8.5px;
        font-weight: 600;
        color: ${colors.text.primary};
      }
      #ohlcv-hud .hud-v.up { color: ${colors.status.success}; }
      #ohlcv-hud .hud-v.down { color: ${colors.status.error}; }
      #draw-start, #draw-end {
        position: absolute;
        width: 8px;
        height: 8px;
        border-radius: 999px;
        border: 2px solid #60a5fa;
        background: rgba(0, 0, 0, 0.2);
        transform: translate(-50%, -50%);
        pointer-events: none;
        opacity: 0;
        z-index: 12;
      }
      #draw-layer {
        position: absolute;
        left: 0;
        top: 0;
        width: 100%;
        height: 100%;
        z-index: 11;
        pointer-events: none;
        touch-action: none;
      }
      #draw-confirm {
        position: absolute;
        z-index: 30;
        display: none;
        flex-direction: column;
        gap: 4px;
        background: rgba(10, 10, 15, 0.92);
        border: 1px solid ${colors.border.primary};
        border-radius: 8px;
        padding: 5px;
        pointer-events: auto;
      }
      #draw-confirm-actions {
        display: flex;
        flex-direction: row;
        gap: 4px;
        justify-content: center;
      }
      #draw-confirm-actions button, #draw-color-btn {
        width: 30px;
        height: 30px;
        border-radius: 6px;
        border: 1px solid ${colors.border.primary};
        font-size: 16px;
        line-height: 1;
        cursor: pointer;
        background: transparent;
        -webkit-appearance: none;
        -webkit-tap-highlight-color: transparent;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        margin: 0;
        text-align: center;
        box-sizing: border-box;
      }
      #draw-color-btn {
        position: relative;
      }
      #draw-color-btn .swatch {
        width: 14px;
        height: 14px;
        border-radius: 50%;
        border: 1.5px solid rgba(255,255,255,0.4);
      }
      #draw-yes { color: ${colors.status.success}; border-color: ${colors.status.success}60; }
      #draw-no { color: ${colors.status.error}; border-color: ${colors.status.error}60; }
      #draw-colors {
        display: none;
        flex-direction: row;
        gap: 4px;
        justify-content: center;
        padding-top: 2px;
      }
      #draw-colors.open { display: flex; }
      .draw-color-dot {
        width: 18px;
        height: 18px;
        border-radius: 50%;
        border: 2px solid transparent;
        cursor: pointer;
        -webkit-appearance: none;
        -webkit-tap-highlight-color: transparent;
        padding: 0;
        box-sizing: border-box;
      }
      .draw-color-dot.active {
        border-color: #fff;
      }
    </style>
    ${lwcScriptTag}
  </head>
  <body>
    <div id="chart-root">
      <div id="chart-main-wrap">
        <div id="high-label" class="extreme-label">--</div>
        <div id="low-label" class="extreme-label">--</div>
        <div id="ind-toggle"><svg width="10" height="10" viewBox="0 0 10 10" fill="none"><polyline points="2,3 5,7 8,3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
        <div id="indicator-values">
          <div id="ind-values-stack"></div>
        </div>
        <div id="crosshair-dot"></div>
        <div id="future-time-label">--</div>
        <div id="ohlcv-hud">
          <span class="hud-item"><span class="hud-k">O</span><span class="hud-v" id="hud-o">--</span></span>
          <span class="hud-item"><span class="hud-k">H</span><span class="hud-v" id="hud-h">--</span></span>
          <span class="hud-item"><span class="hud-k">L</span><span class="hud-v" id="hud-l">--</span></span>
          <span class="hud-item"><span class="hud-k">C</span><span class="hud-v" id="hud-c">--</span></span>
          <span class="hud-item"><span class="hud-v" id="hud-chg">--</span></span>
          <span class="hud-item"><span class="hud-k">V</span><span class="hud-v" id="hud-v">--</span></span>
          <span class="hud-item"><span class="hud-k">N</span><span class="hud-v" id="hud-n">--</span></span>
        </div>
        <div id="draw-start"></div>
        <div id="draw-end"></div>
        <canvas id="draw-layer"></canvas>
        <div id="draw-confirm"><div id="draw-confirm-actions"><button id="draw-yes"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><polyline points="2,7 6,11 12,3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button><button id="draw-no"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button><div id="draw-color-btn"><div class="swatch"></div></div></div><div id="draw-colors"></div></div>
        <div id="chart-main"></div>
        <div id="trade-markers-root"></div>
      </div>
      <div id="chart-subs"></div>
    </div>
    <script>
      const payload = ${JSON.stringify(payload)};
      window.__startChart = () => {
        if (window.__chartStarted) return;
        if (!window.LightweightCharts) {
          if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
            window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'chart-error', msg: 'LWC missing before start' }));
          }
          return;
        }
        window.__chartStarted = true;
        var CX_RATE = ${cConverted ? cRate : 1};
        var CX_SYM = '${cConverted ? cMeta.symbol : '$'}';
        var CX_DEC = ${cMeta.decimals};
        function cx(p) { return p * CX_RATE; }
        function cxCandle(c) { return { time: c.time, open: cx(c.open), high: cx(c.high), low: cx(c.low), close: cx(c.close), volume: c.volume, trades: c.trades }; }
        function uniqueSortedCandles(rows) {
          if (!rows || !rows.length) return [];
          var sorted = rows.slice().sort(function(a, b) { return a.time - b.time; });
          var out = [sorted[0]];
          for (var i = 1; i < sorted.length; i++) {
            var c = sorted[i];
            var p = out[out.length - 1];
            if (p && p.time === c.time) {
              out[out.length - 1] = {
                time: c.time,
                open: p.open,
                high: Math.max(p.high, c.high),
                low: Math.min(p.low, c.low),
                close: c.close,
                volume: c.volume,
                trades: c.trades != null ? c.trades : p.trades,
              };
            } else {
              out.push(c);
            }
          }
          return out;
        }
        const CHART_HEIGHT = ${CHART_HEIGHT};
        let data = uniqueSortedCandles((payload.candles || []).map(cxCandle));
        // 'utc-month' = calendar 1M bars (open on the 1st); 'hl' = fixed HL step.
        let timeAlign = 'hl';
        function addUtcCalendarMonthsSec(baseSec, months) {
          var d = new Date(baseSec * 1000);
          return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1) / 1000);
        }
        function detectCalendarMonthBars(candles) {
          if (!candles || candles.length < 2) return false;
          var daySec = 86400;
          var n = Math.min(4, candles.length);
          for (var i = candles.length - n; i < candles.length; i++) {
            var dt = new Date(candles[i].time * 1000);
            if (dt.getUTCDate() !== 1 || dt.getUTCHours() !== 0) return false;
          }
          for (var j = candles.length - n + 1; j < candles.length; j++) {
            var gap = candles[j].time - candles[j - 1].time;
            if (gap < 28 * daySec || gap > 31 * daySec) return false;
          }
          return true;
        }
        function refreshTimeAlign() {
          timeAlign = detectCalendarMonthBars(data) ? 'utc-month' : 'hl';
        }
        function utcCalendarMonthsBetween(earlierSec, laterSec) {
          if (laterSec <= earlierSec) return 0;
          var whole = 0;
          while (whole < 600) {
            var next = addUtcCalendarMonthsSec(earlierSec, whole + 1);
            if (next > laterSec) {
              if (whole === 0) return (laterSec - earlierSec) / (next - earlierSec);
              var prev = addUtcCalendarMonthsSec(earlierSec, whole);
              return whole + (laterSec - prev) / (next - prev);
            }
            if (next === laterSec) return whole + 1;
            whole++;
          }
          return whole;
        }
        function extrapolateTimeFromLast(lastT, barsAhead) {
          if (timeAlign === 'utc-month') return addUtcCalendarMonthsSec(lastT, barsAhead);
          return lastT + barsAhead * barStepSec();
        }
        refreshTimeAlign();
        function candleField(c, source) {
          var src = source || 'close';
          var o = c.open, h = c.high, l = c.low, cl = c.close;
          if (src === 'open') return o;
          if (src === 'high') return h;
          if (src === 'low') return l;
          if (src === 'close') return cl;
          if (src === 'hl2') return (h + l) / 2;
          if (src === 'ohlc4') return (o + h + l + cl) / 4;
          return cl;
        }
        const MAX_POINTS = 3000;
        const TRIM_THRESHOLD = 3600;
        // Default zoom: ~45 bars on screen. Keep this width even when the
        // series has fewer candles (new listings) so bars don't stretch to
        // fill the pane; empty logical space sits to the left of bar 0.
        const DEFAULT_VIEW_BARS = 45;
        const VIEW_RIGHT_PAD = 14;
        const rootEl = document.getElementById('chart-root');
        const mainWrap = document.getElementById('chart-main-wrap');
        const mainChartEl = document.getElementById('chart-main');
        const subRoot = document.getElementById('chart-subs');
        // Suppress the CSS height transitions (0.15s ease-out) on the first
        // layout pass. Otherwise the initial applyLayout() height writes get
        // animated and the main candle pane visibly scales vertically while
        // the dim overlay is fading out. Restored on chart-settled below so
        // indicator toggles keep their smooth transition afterwards.
        if (mainWrap) mainWrap.style.transition = 'none';
        if (subRoot) subRoot.style.transition = 'none';
        const SUB_HEIGHT = ${SUB_PANE_HEIGHT};
        const SUB_GAP = 8;
        let currentSubCount = 0;
        let subCharts = {};
        let isSyncingRange = false;
        let muteSubToMainUntil = 0;
        let hasInitializedViewport = false;
        let lastViewportPostTs = 0;
        let showOrderLines = payload.settings?.showOrderLines !== false;
        let showHighLow = payload.settings?.showHighLow !== false;
        let showOhlcvHud = payload.settings?.showOhlcvHud !== false;
        let showTradeMarkers = payload.settings?.showTradeMarkers === true;
        let tradeMarkersList = [];
        let useUtc = payload.settings?.useUtc === true;  // Default to local (false)
        let drawingEnabled = payload.settings?.drawingEnabled === true;
        let activeTool = payload.settings?.drawTool || 'trendline';
        let entryLineRef = null;
        let liqLineRef = null;
        let limitLineRefs = [];
        let isDrawing = false;
        let lineStart = null;
        let lineEnd = null;
        let confirmedDrawings = [];
        let pendingConfirm = false;
        let lastPreviewEnd = null;
        let selectedDrawingIdx = -1;
        let editingDrawingIdx = -1;
        let editingEndpoint = null;
        let editingDownX = 0;
        let editingDownY = 0;
        let editingDidMove = false;
        let activeColor = '#60a5fa';
        const drawColors = ['#60a5fa','#ef4444','#22c55e','#f59e0b','#a855f7','#ffffff','#ec4899'];

      const formatTimeLabel = (time) => {
        const sec = (typeof time === 'object' && time && 'year' in time)
          ? Math.floor(Date.UTC(time.year, (time.month || 1) - 1, time.day || 1) / 1000)
          : Number(time);
        if (!Number.isFinite(sec)) return '';
        const d = new Date(sec * 1000);
        if (useUtc) {
          return d.toISOString().replace('T', ' ').slice(0, 16);
        }
        return d.toLocaleString();
      };

      const formatTick = (time) => {
        const sec = (typeof time === 'object' && time && 'year' in time)
          ? Math.floor(Date.UTC(time.year, (time.month || 1) - 1, time.day || 1) / 1000)
          : Number(time);
        if (!Number.isFinite(sec)) return '';
        const d = new Date(sec * 1000);
        return useUtc
          ? d.toISOString().slice(5, 10).replace('-', '/')
          : d.toLocaleDateString();
      };

      const fmtHL = (n) => {
        if (!Number.isFinite(n)) return '--';
        const abs = Math.abs(n);
        var txt;
        if (CX_DEC === 0 && CX_RATE > 1) {
          if (abs >= 1e9) txt = (abs / 1e9).toFixed(3) + 'B';
          else if (abs >= 1e6) txt = (abs / 1e6).toFixed(3) + 'M';
          else if (abs >= 1e3) txt = Math.round(abs).toLocaleString('en-US');
          else txt = Math.round(abs).toString();
        } else {
          if (abs >= 10000) txt = n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
          else if (abs >= 100) txt = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
          else if (abs >= 1) txt = n.toFixed(3);
          else if (abs >= 0.1) txt = n.toFixed(4);
          else if (abs >= 0.01) txt = n.toFixed(5);
          else if (abs >= 0.001) txt = n.toFixed(6);
          else txt = n.toFixed(8);
        }
        return CX_SYM + txt;
      };

      const mainChart = LightweightCharts.createChart(mainChartEl, {
        layout: {
          background: { color: '${colors.background.primary}' },
          textColor: '${colors.text.secondary}',
          fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif',
        },
        grid: {
          vertLines: { color: '${colors.border.primary}', style: 0, visible: true },
          horzLines: { color: '${colors.border.primary}', style: 0, visible: true },
        },
        timeScale: {
          borderColor: 'transparent',
          timeVisible: true,
          secondsVisible: false,
          tickMarkFormatter: function() { return ''; },
          visible: true,
          fixLeftEdge: false,
          fixRightEdge: false,
        },
        rightPriceScale: {
          borderColor: '${colors.border.primary}',
          minimumWidth: 88,
          scaleMargins: { top: 0.12, bottom: 0.28 },
          mode: LightweightCharts.PriceScaleMode.Normal,
          autoScale: true,
          alignLabels: true,
        },
        localization: {
          timeFormatter: formatTimeLabel,
          priceFormatter: function(price) {
            if (!Number.isFinite(price)) return '--';
            var abs = Math.abs(price);
            if (CX_DEC === 0 && CX_RATE > 1) {
              if (abs >= 1e9) return CX_SYM + (abs / 1e9).toFixed(3) + 'B';
              if (abs >= 1e6) return CX_SYM + (abs / 1e6).toFixed(3) + 'M';
              if (abs >= 1e3) return CX_SYM + Math.round(abs).toLocaleString('en-US');
              return CX_SYM + Math.round(abs).toString();
            }
            if (abs >= 10000) return CX_SYM + price.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
            if (abs >= 100) return CX_SYM + price.toFixed(2);
            if (abs >= 1) return CX_SYM + price.toFixed(3);
            if (abs >= 0.1) return CX_SYM + price.toFixed(4);
            return CX_SYM + price.toFixed(6);
          },
        },
        crosshair: {
          mode: LightweightCharts.CrosshairMode.Normal,
          vertLine: {
            color: drawingEnabled ? '#60a5fa' : '${colors.text.tertiary}',
            width: 1,
            style: drawingEnabled ? 2 : 0,
            labelBackgroundColor: '${colors.background.primary}',
          },
          horzLine: {
            color: drawingEnabled ? '#60a5fa' : '${colors.text.tertiary}',
            width: 1,
            style: drawingEnabled ? 2 : 0,
            labelBackgroundColor: '${colors.background.primary}',
          },
        },
        handleScroll: {
          mouseWheel: true,
          pressedMouseMove: true,
          horzTouchDrag: true,
          vertTouchDrag: false,
        },
        handleScale: {
          axisPressedMouseMove: false,
          mouseWheel: true,
          pinch: true,
        },
      });

      const chart = mainChart;

      var refPrice = data.length ? data[data.length - 1].close : 0;
      var pricePrecision = 2;
      var priceMinMove = 0.01;
      if (CX_DEC === 0 && CX_RATE > 1) {
        if (refPrice >= 100000) { pricePrecision = 0; priceMinMove = 1; }
        else if (refPrice >= 1000) { pricePrecision = 0; priceMinMove = 1; }
        else if (refPrice >= 1) { pricePrecision = 1; priceMinMove = 0.1; }
        else { pricePrecision = 2; priceMinMove = 0.01; }
      } else if (refPrice > 0) {
        if (refPrice >= 10000) { pricePrecision = 1; priceMinMove = 0.1; }
        else if (refPrice >= 100) { pricePrecision = 2; priceMinMove = 0.01; }
        else if (refPrice >= 1) { pricePrecision = 3; priceMinMove = 0.001; }
        else if (refPrice >= 0.1) { pricePrecision = 4; priceMinMove = 0.0001; }
        else if (refPrice >= 0.01) { pricePrecision = 5; priceMinMove = 0.00001; }
        else if (refPrice >= 0.001) { pricePrecision = 6; priceMinMove = 0.000001; }
        else { pricePrecision = 8; priceMinMove = 0.00000001; }
      }
      var priceFmt = { type: 'price', precision: pricePrecision, minMove: priceMinMove };

      const candleSeries = mainChart.addCandlestickSeries({
        upColor: '${colors.status.success}',
        downColor: '${colors.status.error}',
        borderVisible: false,
        wickUpColor: '${colors.status.success}',
        wickDownColor: '${colors.status.error}',
        lastPriceAnimation: LightweightCharts.LastPriceAnimationMode.On,
        lastValueVisible: true,
        priceLineVisible: true,
        priceFormat: priceFmt,
      });

      // ── Smooth line + gradient area series (Liveline-style) ──
      const lineData = data.map(function(c) { return { time: c.time, value: c.close }; });
      const smoothLineSeries = mainChart.addLineSeries({
        color: '${colors.accent.gold}',
        lineWidth: 2,
        crosshairMarkerVisible: true,
        crosshairMarkerRadius: 5,
        crosshairMarkerBorderColor: '${colors.accent.gold}',
        crosshairMarkerBackgroundColor: '${colors.background.primary}',
        lastPriceAnimation: LightweightCharts.LastPriceAnimationMode.Disabled,
        lastValueVisible: true,
        priceLineVisible: true,
        priceLineWidth: 1,
        priceLineStyle: 2,
        priceLineColor: '${colors.accent.gold}88',
        visible: false,
        priceFormat: priceFmt,
      });
      smoothLineSeries.setData(lineData);

      const areaGlowSeries = mainChart.addAreaSeries({
        topColor: '${colors.accent.gold}40',
        bottomColor: '${colors.accent.gold}02',
        lineColor: 'transparent',
        lineWidth: 0,
        crosshairMarkerVisible: false,
        lastValueVisible: false,
        priceLineVisible: false,
        visible: false,
        priceFormat: priceFmt,
      });
      areaGlowSeries.setData(lineData);

      let currentChartMode = payload.settings?.chartMode || 'candle';

      function applyChartMode(mode) {
        currentChartMode = mode || 'candle';
        const isLine = currentChartMode === 'line';
        candleSeries.applyOptions({ visible: !isLine });
        smoothLineSeries.applyOptions({ visible: isLine });
        areaGlowSeries.applyOptions({ visible: isLine });
        // In line mode hide the price line from candle series
        candleSeries.applyOptions({
          lastValueVisible: !isLine,
          priceLineVisible: !isLine,
        });
        // Re-apply order lines to the correct series
        applyOrderLines();
      }
      applyChartMode(currentChartMode);

      // ── Pulsing live dot overlay for line mode ──
      const pulseDot = document.createElement('div');
      pulseDot.id = 'pulse-dot';
      pulseDot.style.cssText = 'position:absolute;z-index:24;pointer-events:none;width:8px;height:8px;' +
        'border-radius:50%;background:${colors.accent.gold};box-shadow:0 0 12px ${colors.accent.gold}88,0 0 4px ${colors.accent.gold};' +
        'opacity:0;transition:opacity 0.3s ease;';
      // Pulse animation via CSS
      const pulseStyle = document.createElement('style');
      pulseStyle.textContent = '@keyframes pulseLive{0%,100%{box-shadow:0 0 12px ${colors.accent.gold}88,0 0 4px ${colors.accent.gold};transform:translate(-50%,-50%) scale(1)}50%{box-shadow:0 0 20px ${colors.accent.gold}cc,0 0 8px ${colors.accent.gold};transform:translate(-50%,-50%) scale(1.3)}}#pulse-dot{animation:pulseLive 2s ease-in-out infinite;transform:translate(-50%,-50%)}';
      document.head.appendChild(pulseStyle);
      mainWrap.appendChild(pulseDot);

      function updatePulseDotPosition() {
        if (currentChartMode !== 'line' || !data.length) {
          pulseDot.style.opacity = '0';
          return;
        }
        const lastPoint = data[data.length - 1];
        const x = chart.timeScale().timeToCoordinate(lastPoint.time);
        const y = smoothLineSeries.priceToCoordinate(lastPoint.close);
        if (x !== null && y !== null) {
          pulseDot.style.left = x + 'px';
          pulseDot.style.top = y + 'px';
          pulseDot.style.opacity = '1';
        } else {
          pulseDot.style.opacity = '0';
        }
      }

      // Update pulse dot + H/L labels on every logical-range pan/zoom.
      // Visible TIME-range events are throttled (and barely change when a
      // short history like a new 1w listing still fits entirely on screen),
      // so labels would otherwise stay glued to stale pixel coords until
      // scroll settles — then snap back. Logical range moves every frame.
      chart.timeScale().subscribeVisibleLogicalRangeChange(function() {
        if (currentChartMode === 'line') updatePulseDotPosition();
        scheduleRangeUpdate();
      });

      candleSeries.setData(data);
      // Apply the default 45-bar viewport SYNCHRONOUSLY here so the
      // chart engine never paints its native fit-all-bars layout —
      // otherwise the user sees ~240 tiny zoomed-out candles for a few
      // frames before applyDefaultMainViewport runs inside
      // rebuildIndicators' deferred setTimeout(0). That brief
      // fit-content paint is exactly what bleeds through the (only
      // 55%-opaque) dim overlay and looks like "more candles than the
      // default" on first boot. Function is hoisted so it's safe to
      // call before its declaration site below.
      try { applyDefaultMainViewport(); } catch (e) {}
      setTimeout(() => {
        updateRangeInfo(mainChart.timeScale().getVisibleRange());
      }, 0);

      function clearSubCharts() {
        Object.values(subCharts).forEach((s) => s.chart.remove());
        subCharts = {};
        while (subRoot.firstChild) subRoot.removeChild(subRoot.firstChild);
      }

      function getScaleWidthFor(chartApi) {
        try {
          const scaleApi = chartApi && chartApi.priceScale ? chartApi.priceScale('right') : null;
          const widthFn = scaleApi && scaleApi.width;
          if (typeof widthFn === 'function') {
            const width = Number(widthFn.call(scaleApi));
            if (Number.isFinite(width) && width > 0) return Math.ceil(width);
          }
        } catch {}
        return 0;
      }

      function getMainScaleWidth() {
        return getScaleWidthFor(mainChart);
      }

      function syncPriceScaleWidths() {
        const measuredMain = getMainScaleWidth();
        let targetWidth = Math.max(88, measuredMain || 0);
        Object.values(subCharts).forEach((s) => {
          const width = getScaleWidthFor(s.chart);
          if (width > targetWidth) targetWidth = width;
        });
        mainChart.applyOptions({
          rightPriceScale: {
            minimumWidth: targetWidth,
          },
        });
        Object.values(subCharts).forEach((s) => {
          s.chart.applyOptions({
            rightPriceScale: {
              minimumWidth: targetWidth,
            },
          });
        });
      }

      function applyLayout(subCount) {
        currentSubCount = subCount;
        const totalHeight = rootEl.clientHeight || document.body.clientHeight || window.innerHeight || 0;
        const totalWidth = mainWrap.clientWidth || rootEl.clientWidth || document.body.clientWidth || window.innerWidth || 0;
        const subTotal = subCount > 0 ? (subCount * SUB_HEIGHT) + ((subCount - 1) * SUB_GAP) : 0;
        const rootGap = subCount > 0 ? SUB_GAP : 0;
        const mainHeight = Math.max(120, (totalHeight || CHART_HEIGHT) - subTotal - rootGap);
        mainWrap.style.height = mainHeight + 'px';
        mainChart.applyOptions({ width: mainWrap.clientWidth, height: mainHeight });
        Object.values(subCharts).forEach((s) => {
          s.el.style.height = SUB_HEIGHT + 'px';
          s.el.style.width = totalWidth ? (totalWidth + 'px') : '100%';
          s.chart.applyOptions({ width: s.el.clientWidth || totalWidth, height: SUB_HEIGHT });
        });
        subRoot.style.display = subCount > 0 ? 'flex' : 'none';
        subRoot.style.height = subCount > 0 ? (subTotal + 'px') : '0px';
        subRoot.style.overflow = 'hidden';
        syncPriceScaleWidths();
        if (!totalHeight || !mainWrap.clientWidth) {
          setTimeout(() => applyLayout(subCount), 50);
        }
      }

      function getNumericRange(range) {
        if (!range || range.from === null || range.from === undefined || range.to === null || range.to === undefined) {
          return null;
        }
        const from = Number(range.from);
        const to = Number(range.to);
        if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
        if (to <= from) return null;
        return { from, to };
      }

      function getNumericLogicalRange(range) {
        if (!range || range.from === null || range.from === undefined || range.to === null || range.to === undefined) {
          return null;
        }
        const from = Number(range.from);
        const to = Number(range.to);
        if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
        if (to <= from) return null;
        return { from, to };
      }

      function ensureRightGap() {
        if (!data.length) return;
        const logicalRange = getNumericLogicalRange(mainChart.timeScale().getVisibleLogicalRange());
        if (!logicalRange) return;
        // Floor for the visible-range right edge. Must mirror the
        // chart-level default right-pad (+14). This is what fixes
        // the "new padding only shows up after interval switch"
        // bug: on cold boot, RN restores the persisted viewport via
        // __setViewport using whatever pad was current when it was
        // captured (often the older +6/+10). Without a matching
        // floor here, that restored range visually reverts the new
        // default. Bumping this up pulls the restored range forward
        // to the new default whenever it's tighter than +14.
        const desiredTo = (data.length - 1) + 14;
        if (logicalRange.to >= desiredTo - 0.01) return;
        const span = logicalRange.to - logicalRange.from;
        const shifted = { from: desiredTo - span, to: desiredTo };
        try {
          mainChart.timeScale().setVisibleLogicalRange(shifted);
        } catch {}
      }

      /** Same ~45-bar window as reset — never use fitContent() here (fitContent = entire series = tiny candles). */
      function applyDefaultMainViewport() {
        if (!data.length) return;
        // Always span DEFAULT_VIEW_BARS (not Math.min with data.length).
        // Thin history used to shrink the window to every bar → huge candles.
        // The "+ VIEW_RIGHT_PAD" must match timeScale.rightOffset at creation.
        var to = data.length - 1 + VIEW_RIGHT_PAD;
        var from = to - DEFAULT_VIEW_BARS;
        try {
          mainChart.timeScale().setVisibleLogicalRange({ from: from, to: to });
          mainChart.timeScale().applyOptions({
            fixLeftEdge: data.length >= DEFAULT_VIEW_BARS,
          });
        } catch (e) {}
      }

      function postViewportState(force) {
        if (!window.ReactNativeWebView || !window.ReactNativeWebView.postMessage) return;
        const now = Date.now();
        if (!force && now - lastViewportPostTs < 120) return;
        lastViewportPostTs = now;
        const timeRange = getNumericRange(mainChart.timeScale().getVisibleRange());
        const logicalRange = getNumericLogicalRange(mainChart.timeScale().getVisibleLogicalRange());
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'viewport',
          timeRange,
          logicalRange,
        }));
      }

      function isRangeNearlyEqual(a, b) {
        if (!a || !b) return false;
        const span = Math.max(1, Math.abs(a.to - a.from), Math.abs(b.to - b.from));
        const tol = span * 0.002;
        return Math.abs(a.from - b.from) <= tol && Math.abs(a.to - b.to) <= tol;
      }

      function createSubChart(key) {
        const el = document.createElement('div');
        el.className = 'sub-chart';
        el.style.height = SUB_HEIGHT + 'px';
        el.style.width = '100%';
        subRoot.appendChild(el);
        const chart = LightweightCharts.createChart(el, {
          layout: {
            background: { color: '${colors.background.primary}' },
            textColor: '${colors.text.secondary}',
            fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif',
          },
          grid: {
            vertLines: { color: '${colors.border.primary}', style: 0, visible: false },
            horzLines: { color: '${colors.border.primary}', style: 0, visible: true },
          },
          timeScale: {
            borderColor: '${colors.border.primary}',
            timeVisible: false,
            secondsVisible: false,
            visible: false,
            // 14 bars of empty space past the latest candle. Sized to
            // clear the widest axis-label pills we now render:
            // "Avg." (entry), "Liq." (liquidation), plus "tp"/"sl"
            // trigger badges, without making the chart feel too
            // scrolled-right on first load.
            rightOffset: 14,
            barSpacing: 8,
            minBarSpacing: 1,
            fixLeftEdge: true,
            lockVisibleTimeRangeOnResize: true,
          },
          rightPriceScale: {
            borderColor: '${colors.border.primary}',
            minimumWidth: 88,
            scaleMargins: { top: 0.28, bottom: 0.24 },
            mode: LightweightCharts.PriceScaleMode.Normal,
            autoScale: true,
            alignLabels: true,
          },
          crosshair: {
            mode: LightweightCharts.CrosshairMode.Hidden,
          },
          handleScroll: {
            mouseWheel: false,
            pressedMouseMove: true,
            horzTouchDrag: true,
            vertTouchDrag: false,
          },
          handleScale: {
            axisPressedMouseMove: false,
            mouseWheel: true,
            pinch: true,
          },
        });
        const label = document.createElement('div');
        label.className = 'sub-chart-label';
        label.textContent = key.toUpperCase();
        el.appendChild(label);
        subCharts[key] = { chart, el };
        chart.timeScale().subscribeVisibleLogicalRangeChange((logicalRange) => {
          const safeLogicalRange = getNumericLogicalRange(logicalRange);
          if (!safeLogicalRange || isSyncingRange) return;
          if (Date.now() < muteSubToMainUntil) return;
          const currentMainLogicalRange = getNumericLogicalRange(mainChart.timeScale().getVisibleLogicalRange());
          if (currentMainLogicalRange && isRangeNearlyEqual(currentMainLogicalRange, safeLogicalRange)) return;
          isSyncingRange = true;
          try {
            mainChart.timeScale().setVisibleLogicalRange(safeLogicalRange);
          } catch {}
          isSyncingRange = false;
        });
        const logicalRange = getNumericLogicalRange(mainChart.timeScale().getVisibleLogicalRange());
        if (logicalRange) {
          try {
            chart.timeScale().setVisibleLogicalRange(logicalRange);
          } catch {}
        } else {
          const range = getNumericRange(mainChart.timeScale().getVisibleRange());
          if (range) {
            try {
              chart.timeScale().setVisibleRange(range);
            } catch {}
          }
        }
        return { chart, el };
      }

      function computeEMASeries(period, source) {
        var src = source || 'close';
        if (!Number.isFinite(period) || period <= 0) return [];
        if (data.length < period + 1) return [];
        const k = 2 / (period + 1);
        let ema = null;
        const out = [];
        for (let i = 0; i < data.length; i++) {
          const v = candleField(data[i], src);
          if (ema === null) {
            ema = v;
          } else {
            ema = v * k + ema * (1 - k);
          }
          if (i >= period - 1) {
            out.push({ time: data[i].time, value: ema });
          }
        }
        return out;
      }

      function computeSMASeries(period, source) {
        var src = source || 'close';
        if (!Number.isFinite(period) || period <= 0) return [];
        if (data.length < period + 1) return [];
        const out = [];
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          sum += candleField(data[i], src);
          if (i >= period) {
            sum -= candleField(data[i - period], src);
          }
          if (i >= period - 1) {
            out.push({ time: data[i].time, value: sum / period });
          }
        }
        return out;
      }

      function computeMACD() {
        const ema12 = computeEMASeries(12, 'close');
        const ema26 = computeEMASeries(26, 'close');
        const map12 = new Map(ema12.map((e) => [e.time, e.value]));
        const map26 = new Map(ema26.map((e) => [e.time, e.value]));
        const macd = [];
        const times = [];
        data.forEach((c) => {
          if (map12.has(c.time) && map26.has(c.time)) {
            const v = map12.get(c.time) - map26.get(c.time);
            macd.push({ time: c.time, value: v });
            times.push(c.time);
          }
        });
        // signal EMA 9 over macd
        const signal = [];
        let ema = null;
        const k = 2 / (9 + 1);
        for (let i = 0; i < macd.length; i++) {
          const v = macd[i].value;
          if (ema === null) {
            ema = v;
          } else {
            ema = v * k + ema * (1 - k);
          }
          signal.push({ time: macd[i].time, value: ema });
        }
        const hist = macd.map((m, i) => ({
          time: m.time,
          value: m.value - (signal[i]?.value ?? 0),
        }));
        return { macd, signal, hist };
      }

      function computeATR(period) {
        const out = [];
        let sum = 0;
        for (let i = 1; i < data.length; i++) {
          const high = data[i].high;
          const low = data[i].low;
          const prevClose = data[i - 1].close;
          const tr = Math.max(
            high - low,
            Math.abs(high - prevClose),
            Math.abs(low - prevClose),
          );
          sum += tr;
          if (i >= period) {
            const prevHigh = data[i - period].high;
            const prevLow = data[i - period].low;
            const prevPrevClose = data[i - period - 1]?.close ?? prevClose;
            const prevTr = Math.max(
              prevHigh - prevLow,
              Math.abs(prevHigh - prevPrevClose),
              Math.abs(prevLow - prevPrevClose),
            );
            sum -= prevTr;
          }
          if (i >= period) {
            out.push({ time: data[i].time, value: sum / period });
          }
        }
        return out;
      }

      function computeSupertrend(period, mult) {
        const atr = computeATR(period);
        const atrMap = new Map(atr.map((a) => [a.time, a.value]));
        const out = [];
        let prevUpper = null;
        let prevLower = null;
        let prevTrend = 1;
        for (let i = 0; i < data.length; i++) {
          const c = data[i];
          const a = atrMap.get(c.time);
          if (!a) continue;
          const hl2 = (c.high + c.low) / 2;
          let upper = hl2 + mult * a;
          let lower = hl2 - mult * a;
          if (prevUpper !== null) {
            if (upper > prevUpper && data[i - 1]?.close <= prevUpper) {
              upper = prevUpper;
            }
            if (lower < prevLower && data[i - 1]?.close >= prevLower) {
              lower = prevLower;
            }
          }
          let trend = prevTrend;
          if (c.close > (prevUpper ?? upper)) trend = 1;
          if (c.close < (prevLower ?? lower)) trend = -1;
          const value = trend === 1 ? lower : upper;
          out.push({ time: c.time, value });
          prevUpper = upper;
          prevLower = lower;
          prevTrend = trend;
        }
        return out;
      }

      function computeBollinger(period, mult) {
        const out = { mid: [], upper: [], lower: [] };
        let sum = 0;
        let sumSq = 0;
        for (let i = 0; i < data.length; i++) {
          const v = data[i].close;
          sum += v;
          sumSq += v * v;
          if (i >= period) {
            const drop = data[i - period].close;
            sum -= drop;
            sumSq -= drop * drop;
          }
          if (i >= period - 1) {
            const mean = sum / period;
            const variance = Math.max(0, (sumSq / period) - mean * mean);
            const std = Math.sqrt(variance);
            out.mid.push({ time: data[i].time, value: mean });
            out.upper.push({ time: data[i].time, value: mean + mult * std });
            out.lower.push({ time: data[i].time, value: mean - mult * std });
          }
        }
        return out;
      }

      function resolveBollCfg(ind) {
        var bc = (ind && ind.bollConfig) || {};
        var L = parseInt(String(bc.length != null ? bc.length : 20), 10);
        if (!Number.isFinite(L) || L < 2) L = 20;
        if (L > 500) L = 500;
        var M = parseFloat(String(bc.multiplier != null ? bc.multiplier : 2));
        if (!Number.isFinite(M) || M <= 0) M = 2;
        if (M > 50) M = 50;
        function ls(v) {
          var n = Number(v);
          return n >= 0 && n <= 4 ? n : 0;
        }
        return {
          length: L,
          multiplier: M,
          showBackground: bc.showBackground !== false,
          showUpper: bc.showUpper !== false,
          showMid: bc.showMid !== false,
          showLower: bc.showLower !== false,
          backgroundColor: typeof bc.backgroundColor === 'string' ? bc.backgroundColor : 'rgba(100, 116, 139, 0.13)',
          upperColor: typeof bc.upperColor === 'string' ? bc.upperColor : '#64748b',
          midColor: typeof bc.midColor === 'string' ? bc.midColor : '#94a3b8',
          lowerColor: typeof bc.lowerColor === 'string' ? bc.lowerColor : '#64748b',
          upperLineStyle: ls(bc.upperLineStyle),
          midLineStyle: ls(bc.midLineStyle),
          lowerLineStyle: ls(bc.lowerLineStyle),
        };
      }

      function resolveVwapCfg(ind) {
        var vc = (ind && ind.vwapConfig) || {};
        var L = parseInt(String(vc.length != null ? vc.length : 14), 10);
        if (!Number.isFinite(L) || L < 1) L = 14;
        else if (L === 1) L = 14;
        else if (L > 500) L = 500;
        var col = typeof vc.color === 'string' ? vc.color : '#3b82f6';
        var lw = parseInt(String(vc.lineWidth != null ? vc.lineWidth : 2), 10);
        if (!Number.isFinite(lw) || lw < 1) lw = 2;
        if (lw > 4) lw = 4;
        var ls = Number(vc.lineStyle);
        if (!Number.isFinite(ls) || ls < 0 || ls > 4) ls = 0;
        return { length: L, color: col, lineWidth: lw, lineStyle: ls };
      }

      function resolveSupertrendCfg(ind) {
        var sc = (ind && ind.stConfig) || {};
        var P = parseInt(String(sc.period != null ? sc.period : 10), 10);
        if (!Number.isFinite(P) || P < 1) P = 10;
        else if (P > 500) P = 500;
        var M = parseFloat(String(sc.multiplier != null ? sc.multiplier : 3));
        if (!Number.isFinite(M) || M < 0.1) M = 3;
        if (M > 50) M = 50;
        var col = typeof sc.color === 'string' ? sc.color : '#fb7185';
        var lw = parseInt(String(sc.lineWidth != null ? sc.lineWidth : 1), 10);
        if (!Number.isFinite(lw) || lw < 1) lw = 1;
        if (lw > 4) lw = 4;
        var ls = Number(sc.lineStyle);
        if (!Number.isFinite(ls) || ls < 0 || ls > 4) ls = 0;
        return { period: P, multiplier: M, color: col, lineWidth: lw, lineStyle: ls };
      }

      /** Rolling VWAP over the last N bars (volume-weighted typical price). */
      function computeVWAP(periodLen) {
        if (!data.length) return [];
        var L = parseInt(String(periodLen != null ? periodLen : 14), 10);
        if (!Number.isFinite(L) || L < 1) L = 14;
        if (L > 500) L = 500;
        var out = [];
        for (var i = 0; i < data.length; i++) {
          var start = Math.max(0, i - L + 1);
          var sumTP = 0, sumVol = 0;
          for (var j = start; j <= i; j++) {
            var c = data[j];
            var tp = (c.high + c.low + c.close) / 3;
            var vol = c.volume || 0;
            sumTP += tp * vol;
            sumVol += vol;
          }
          if (sumVol > 0) {
            out.push({ time: data[i].time, value: sumTP / sumVol });
          }
        }
        return out;
      }

      function computeRSI(period, source) {
        var src = source || 'close';
        if (!Number.isFinite(period) || period <= 0) return [];
        const out = [];
        let avgGain = 0;
        let avgLoss = 0;
        for (let i = 1; i < data.length; i++) {
          const change = candleField(data[i], src) - candleField(data[i - 1], src);
          const gain = Math.max(0, change);
          const loss = Math.max(0, -change);
          if (i <= period) {
            avgGain += gain;
            avgLoss += loss;
            if (i === period) {
              avgGain /= period;
              avgLoss /= period;
              const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
              out.push({ time: data[i].time, value: 100 - (100 / (1 + rs)) });
            }
          } else {
            avgGain = (avgGain * (period - 1) + gain) / period;
            avgLoss = (avgLoss * (period - 1) + loss) / period;
            const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
            out.push({ time: data[i].time, value: 100 - (100 / (1 + rs)) });
          }
        }
        return out;
      }

      function computeCCI(period) {
        const out = [];
        let sum = 0;
        const typicals = [];
        for (let i = 0; i < data.length; i++) {
          const tp = (data[i].high + data[i].low + data[i].close) / 3;
          typicals.push(tp);
          sum += tp;
          if (i >= period) {
            sum -= typicals[i - period];
          }
          if (i >= period - 1) {
            const mean = sum / period;
            let devSum = 0;
            for (let j = i - period + 1; j <= i; j++) {
              devSum += Math.abs(typicals[j] - mean);
            }
            const meanDev = devSum / period;
            const cci = meanDev === 0 ? 0 : (tp - mean) / (0.015 * meanDev);
            out.push({ time: data[i].time, value: cci });
          }
        }
        return out;
      }

      function padSeriesToAllTimes(points, keepColor) {
        const map = new Map((Array.isArray(points) ? points : []).map((p) => [p.time, p]));
        return data.map((c) => {
          const item = map.get(c.time);
          const value = item?.value;
          if (!Number.isFinite(value)) {
            return { time: c.time };
          }
          if (keepColor && item && item.color) {
            return { time: c.time, value, color: item.color };
          }
          return { time: c.time, value };
        });
      }

      const indicatorSeries = {
        ema: {},
        ma: {},
        boll: null,
        supertrend: null,
      };
      const subSeries = {
        vol: null,
        rsi: {},
        cci: null,
        macd: null,
      };

      function rebuildIndicators(ind) {
        const preservedLogicalRange = getNumericLogicalRange(mainChart.timeScale().getVisibleLogicalRange());
        const preservedRange = getNumericRange(mainChart.timeScale().getVisibleRange());
        subRoot.style.transition = 'none';
        subRoot.style.opacity = '0';
        clearSubCharts();
        subSeries.vol = null;
        subSeries.rsi = {};
        subSeries.cci = null;
        subSeries.macd = null;
        const subOrder = ['rsi', 'vol', 'macd', 'cci'];
        const subKeys = subOrder.filter((key) => ind[key]);
        applyLayout(subKeys.length);

        const legacyEmaColors = {
          7: '#ef4444',
          20: '#f59e0b',
          50: '#a855f7',
          100: '#22c55e',
          200: '#e5e7eb',
        };
        const legacyMaColors = {
          7: '#f97316',
          20: '#60a5fa',
          50: '#34d399',
          100: '#facc15',
          200: '#f472b6',
        };

        Object.keys(indicatorSeries.ema).forEach((k) => {
          chart.removeSeries(indicatorSeries.ema[k]);
        });
        indicatorSeries.ema = {};
        Object.keys(indicatorSeries.ma).forEach((k) => {
          chart.removeSeries(indicatorSeries.ma[k]);
        });
        indicatorSeries.ma = {};
        if (indicatorSeries.boll) {
          indicatorSeries.boll.forEach((s) => chart.removeSeries(s));
          indicatorSeries.boll = null;
        }
        if (indicatorSeries.supertrend) {
          chart.removeSeries(indicatorSeries.supertrend);
          indicatorSeries.supertrend = null;
        }
        if (indicatorSeries.vwap) {
          chart.removeSeries(indicatorSeries.vwap);
          indicatorSeries.vwap = null;
        }

        if (Array.isArray(ind.emaRows) && ind.emaRows.length) {
          ind.emaRows.forEach(function(row, slot) {
            if (!row || !row.enabled) return;
            var period = parseInt(String(row.period), 10) || 0;
            if (period <= 0) return;
            var src = row.source || 'close';
            var col = row.color || '${colors.accent.gold}';
            var series = chart.addLineSeries({
              color: col,
              lineWidth: 1,
              priceLineVisible: false,
              lastValueVisible: false,
              priceFormat: priceFmt,
            });
            series.setData(computeEMASeries(period, src));
            indicatorSeries.ema[String(slot)] = series;
          });
        } else if (ind.ema) {
          Object.keys(ind.ema).forEach((key) => {
            if (!ind.ema[key]) return;
            const period = Number(key);
            const series = chart.addLineSeries({
              color: legacyEmaColors[period] || '${colors.accent.gold}',
              lineWidth: 1,
              priceLineVisible: false,
              lastValueVisible: false,
              priceFormat: priceFmt,
            });
            series.setData(computeEMASeries(period, 'close'));
            indicatorSeries.ema[key] = series;
          });
        }

        if (Array.isArray(ind.maRows) && ind.maRows.length) {
          ind.maRows.forEach(function(row, slot) {
            if (!row || !row.enabled) return;
            var period = parseInt(String(row.period), 10) || 0;
            if (period <= 0) return;
            var src = row.source || 'close';
            var col = row.color || '${colors.accent.blue}';
            var series = chart.addLineSeries({
              color: col,
              lineWidth: 1,
              priceLineVisible: false,
              lastValueVisible: false,
              priceFormat: priceFmt,
            });
            series.setData(computeSMASeries(period, src));
            indicatorSeries.ma[String(slot)] = series;
          });
        } else if (ind.ma) {
          Object.keys(ind.ma).forEach((key) => {
            if (!ind.ma[key]) return;
            const period = Number(key);
            const series = chart.addLineSeries({
              color: legacyMaColors[period] || '${colors.accent.blue}',
              lineWidth: 1,
              priceLineVisible: false,
              lastValueVisible: false,
              priceFormat: priceFmt,
            });
            series.setData(computeSMASeries(period, 'close'));
            indicatorSeries.ma[key] = series;
          });
        }

        if (ind.boll) {
          var bcfg = resolveBollCfg(ind);
          const bands = computeBollinger(bcfg.length, bcfg.multiplier);
          var fillCol = bcfg.backgroundColor || 'rgba(100, 116, 139, 0.13)';
          const bollFillUpper = chart.addAreaSeries({
            topColor: fillCol,
            bottomColor: fillCol,
            lineColor: 'transparent',
            lineWidth: 0,
            visible: bcfg.showBackground,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
            title: '',
            priceFormat: priceFmt,
          });
          const bollFillLower = chart.addAreaSeries({
            topColor: '${colors.background.primary}',
            bottomColor: 'transparent',
            lineColor: 'transparent',
            lineWidth: 0,
            visible: bcfg.showBackground,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
            title: '',
            priceFormat: priceFmt,
          });
          bollFillUpper.setData(bands.upper);
          bollFillLower.setData(bands.lower);
          const upper = chart.addLineSeries({
            color: bcfg.upperColor,
            lineWidth: 1,
            lineStyle: bcfg.upperLineStyle,
            visible: bcfg.showUpper,
            priceLineVisible: false,
            lastValueVisible: false,
            priceFormat: priceFmt,
          });
          const mid = chart.addLineSeries({
            color: bcfg.midColor,
            lineWidth: 1,
            lineStyle: bcfg.midLineStyle,
            visible: bcfg.showMid,
            priceLineVisible: false,
            lastValueVisible: false,
            priceFormat: priceFmt,
          });
          const lower = chart.addLineSeries({
            color: bcfg.lowerColor,
            lineWidth: 1,
            lineStyle: bcfg.lowerLineStyle,
            visible: bcfg.showLower,
            priceLineVisible: false,
            lastValueVisible: false,
            priceFormat: priceFmt,
          });
          upper.setData(bands.upper);
          mid.setData(bands.mid);
          lower.setData(bands.lower);
          indicatorSeries.boll = [upper, mid, lower, bollFillUpper, bollFillLower];
        }

        if (ind.supertrend) {
          var stResolved = resolveSupertrendCfg(ind);
          const st = computeSupertrend(stResolved.period, stResolved.multiplier);
          const series = chart.addLineSeries({
            color: stResolved.color,
            lineWidth: stResolved.lineWidth,
            lineStyle: stResolved.lineStyle,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
            title: '',
            priceFormat: priceFmt,
          });
          series.setData(st);
          indicatorSeries.supertrend = series;
        }

        if (ind.vwap) {
          var vwapResolved = resolveVwapCfg(ind);
          const vwapData = computeVWAP(vwapResolved.length);
          const series = chart.addLineSeries({
            color: vwapResolved.color,
            lineWidth: vwapResolved.lineWidth,
            lineStyle: vwapResolved.lineStyle,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
            title: '',
            priceFormat: priceFmt,
          });
          series.setData(vwapData);
          indicatorSeries.vwap = series;
        }


        subKeys.forEach((key) => {
          const { chart: subChart, el } = createSubChart(key);
          if (key === 'vol') {
            const volumeSeries = subChart.addHistogramSeries({
              priceLineVisible: false,
              lastValueVisible: false,
              color: '#334155',
            });
            volumeSeries.setData(data.map((c) => ({
              time: c.time,
              value: c.volume || 0,
              color: c.close >= c.open ? '${colors.status.success}' : '${colors.status.error}',
            })));
            subSeries.vol = volumeSeries;
          }
          if (key === 'rsi') {
            subSeries.rsi = {};
            if (Array.isArray(ind.rsiRows) && ind.rsiRows.length) {
              ind.rsiRows.forEach(function(row, slot) {
                if (!row || !row.enabled) return;
                var period = parseInt(String(row.period), 10) || 0;
                if (period <= 0) return;
                var src = row.source || 'close';
                var col = row.color || '#38bdf8';
                var rlw = parseInt(String(row.lineWidth != null ? row.lineWidth : 1), 10);
                if (!Number.isFinite(rlw) || rlw < 1) rlw = 1;
                if (rlw > 4) rlw = 4;
                var rls = Number(row.lineStyle);
                if (!Number.isFinite(rls) || rls < 0 || rls > 4) rls = 0;
                const rsiSeries = subChart.addLineSeries({
                  color: col,
                  lineWidth: rlw,
                  lineStyle: rls,
                  priceLineVisible: false,
                  lastValueVisible: false,
                });
                rsiSeries.setData(padSeriesToAllTimes(computeRSI(period, src)));
                subSeries.rsi[String(slot)] = rsiSeries;
              });
            } else {
              const rsiSeries = subChart.addLineSeries({
                color: '#38bdf8',
                lineWidth: 1,
                priceLineVisible: false,
                lastValueVisible: false,
              });
              rsiSeries.setData(padSeriesToAllTimes(computeRSI(14, 'close')));
              subSeries.rsi.legacy = rsiSeries;
            }
          }
          if (key === 'cci') {
            const cciSeries = subChart.addLineSeries({
              color: '#f472b6',
              lineWidth: 1,
              priceLineVisible: false,
              lastValueVisible: false,
            });
            cciSeries.setData(padSeriesToAllTimes(computeCCI(20)));
            subSeries.cci = cciSeries;
          }
          if (key === 'macd') {
            const macd = computeMACD();
            const macdSeries = subChart.addLineSeries({
              color: '#60a5fa',
              lineWidth: 1,
              priceLineVisible: false,
              lastValueVisible: false,
            });
            const signalSeries = subChart.addLineSeries({
              color: '#f59e0b',
              lineWidth: 1,
              priceLineVisible: false,
              lastValueVisible: false,
            });
            const histSeries = subChart.addHistogramSeries({
              priceLineVisible: false,
              lastValueVisible: false,
              color: '#94a3b8',
            });
            macdSeries.setData(padSeriesToAllTimes(macd.macd));
            signalSeries.setData(padSeriesToAllTimes(macd.signal));
            const histColored = macd.hist.map((h) => ({
              time: h.time,
              value: h.value,
              color: h.value >= 0 ? '${colors.status.success}' : '${colors.status.error}',
            }));
            histSeries.setData(padSeriesToAllTimes(histColored, true));
            subSeries.macd = { macdSeries, signalSeries, histSeries };
          }
          const width = el.clientWidth || mainWrap.clientWidth || rootEl.clientWidth || window.innerWidth || 0;
          subChart.applyOptions({ width, height: SUB_HEIGHT });
          const logicalRange = getNumericLogicalRange(mainChart.timeScale().getVisibleLogicalRange());
          if (logicalRange) {
            try {
              subChart.timeScale().setVisibleLogicalRange(logicalRange);
            } catch {
              const range = getNumericRange(mainChart.timeScale().getVisibleRange());
              if (range) {
                try {
                  subChart.timeScale().setVisibleRange(range);
                } catch {}
              }
            }
          } else {
            const range = getNumericRange(mainChart.timeScale().getVisibleRange());
            if (range) {
              try {
                subChart.timeScale().setVisibleRange(range);
              } catch {}
            } else {
              try {
                // Match main chart default viewport (fixed bar count + right pad).
                var sto = data.length - 1 + VIEW_RIGHT_PAD;
                var sfr = sto - DEFAULT_VIEW_BARS;
                subChart.timeScale().setVisibleLogicalRange({ from: sfr, to: sto });
              } catch (e) {}
            }
          }
        });
        setTimeout(() => {
          applyLayout(subKeys.length);
          if (!hasInitializedViewport) {
            applyDefaultMainViewport();
            hasInitializedViewport = true;
          } else if (preservedLogicalRange) {
            try {
              mainChart.timeScale().setVisibleLogicalRange(preservedLogicalRange);
            } catch {}
          } else if (preservedRange) {
            try {
              mainChart.timeScale().setVisibleRange(preservedRange);
            } catch {}
          }
          ensureRightGap();
          let currentRange = getNumericRange(mainChart.timeScale().getVisibleRange());
          if (!currentRange && data.length) {
            applyDefaultMainViewport();
            currentRange = getNumericRange(mainChart.timeScale().getVisibleRange());
          }
          if (currentRange) {
            updateRangeInfo(currentRange);
            syncSubRanges(currentRange);
          }
          scheduleScaleSync();
          requestAnimationFrame(() => {
            const postRange = getNumericRange(mainChart.timeScale().getVisibleRange());
            if (postRange) {
              syncSubRanges(postRange);
            }
            scheduleScaleSync();
            postViewportState(true);
          });
          syncMainIndicatorLineGate();
          requestAnimationFrame(function() {
            subRoot.style.transition = 'opacity 0.15s ease-out';
            subRoot.style.opacity = '1';
          });
        }, 0);
      }

      function mainIndicatorLineGroupShown(group) {
        var mv = payload.settings?.mainIndicatorLineVisibility || {};
        return mv[group] !== false;
      }

      function syncMainIndicatorLineGate() {
        var ind = payload.indicators || {};
        var gateEma = mainIndicatorLineGroupShown('ema');
        var gateMa = mainIndicatorLineGroupShown('ma');
        var gateBoll = mainIndicatorLineGroupShown('boll');
        var gateSt = mainIndicatorLineGroupShown('supertrend');
        var gateVwap = mainIndicatorLineGroupShown('vwap');
        try {
          if (indicatorSeries.ema) {
            if (Array.isArray(ind.emaRows) && ind.emaRows.length) {
              ind.emaRows.forEach(function(row, slot) {
                var s = indicatorSeries.ema[String(slot)];
                if (!s) return;
                var period = parseInt(String(row && row.period), 10) || 0;
                var want = gateEma && !!(row && row.enabled) && period > 0;
                s.applyOptions({ visible: want });
              });
            } else if (ind.ema) {
              Object.keys(ind.ema).forEach(function(k) {
                var s = indicatorSeries.ema[k];
                if (s) s.applyOptions({ visible: gateEma && !!ind.ema[k] });
              });
            }
          }
          if (indicatorSeries.ma) {
            if (Array.isArray(ind.maRows) && ind.maRows.length) {
              ind.maRows.forEach(function(row, slot) {
                var s = indicatorSeries.ma[String(slot)];
                if (!s) return;
                var period = parseInt(String(row && row.period), 10) || 0;
                var want = gateMa && !!(row && row.enabled) && period > 0;
                s.applyOptions({ visible: want });
              });
            } else if (ind.ma) {
              Object.keys(ind.ma).forEach(function(k) {
                var s = indicatorSeries.ma[k];
                if (s) s.applyOptions({ visible: gateMa && !!ind.ma[k] });
              });
            }
          }
          if (ind.boll && indicatorSeries.boll) {
            var bc = resolveBollCfg(ind);
            var gb = gateBoll;
            indicatorSeries.boll[0].applyOptions({ visible: gb && bc.showUpper });
            indicatorSeries.boll[1].applyOptions({ visible: gb && bc.showMid });
            indicatorSeries.boll[2].applyOptions({ visible: gb && bc.showLower });
            if (indicatorSeries.boll[3]) {
              indicatorSeries.boll[3].applyOptions({ visible: gb && bc.showBackground });
            }
            if (indicatorSeries.boll[4]) {
              indicatorSeries.boll[4].applyOptions({ visible: gb && bc.showBackground });
            }
          }
          if (ind.supertrend && indicatorSeries.supertrend) {
            indicatorSeries.supertrend.applyOptions({ visible: gateSt });
          }
          if (ind.vwap && indicatorSeries.vwap) {
            indicatorSeries.vwap.applyOptions({ visible: gateVwap });
          }
        } catch (e) {}
      }

      function updateMainIndicators(ind) {
        if (!ind) return;
        if (Array.isArray(ind.emaRows) && ind.emaRows.length) {
          ind.emaRows.forEach(function(row, slot) {
            if (!row || !row.enabled) return;
            var series = indicatorSeries.ema[String(slot)];
            if (!series) return;
            var period = parseInt(String(row.period), 10) || 0;
            if (period <= 0) return;
            var src = row.source || 'close';
            series.setData(computeEMASeries(period, src));
          });
        } else if (ind.ema) {
          Object.keys(ind.ema).forEach((key) => {
            if (!ind.ema[key]) return;
            const series = indicatorSeries.ema[key];
            if (!series) return;
            series.setData(computeEMASeries(Number(key), 'close'));
          });
        }
        if (Array.isArray(ind.maRows) && ind.maRows.length) {
          ind.maRows.forEach(function(row, slot) {
            if (!row || !row.enabled) return;
            var series = indicatorSeries.ma[String(slot)];
            if (!series) return;
            var period = parseInt(String(row.period), 10) || 0;
            if (period <= 0) return;
            var src = row.source || 'close';
            series.setData(computeSMASeries(period, src));
          });
        } else if (ind.ma) {
          Object.keys(ind.ma).forEach((key) => {
            if (!ind.ma[key]) return;
            const series = indicatorSeries.ma[key];
            if (!series) return;
            series.setData(computeSMASeries(Number(key), 'close'));
          });
        }
        if (ind.boll && indicatorSeries.boll) {
          var bcfg2 = resolveBollCfg(ind);
          const bands = computeBollinger(bcfg2.length, bcfg2.multiplier);
          try {
            indicatorSeries.boll[0].applyOptions({
              color: bcfg2.upperColor,
              lineStyle: bcfg2.upperLineStyle,
              visible: bcfg2.showUpper,
            });
            indicatorSeries.boll[1].applyOptions({
              color: bcfg2.midColor,
              lineStyle: bcfg2.midLineStyle,
              visible: bcfg2.showMid,
            });
            indicatorSeries.boll[2].applyOptions({
              color: bcfg2.lowerColor,
              lineStyle: bcfg2.lowerLineStyle,
              visible: bcfg2.showLower,
            });
            if (indicatorSeries.boll[3]) {
              var fc = bcfg2.backgroundColor || 'rgba(100, 116, 139, 0.13)';
              indicatorSeries.boll[3].applyOptions({
                topColor: fc,
                bottomColor: fc,
                visible: bcfg2.showBackground,
              });
            }
            if (indicatorSeries.boll[4]) {
              indicatorSeries.boll[4].applyOptions({ visible: bcfg2.showBackground });
            }
          } catch (e) {}
          indicatorSeries.boll[0].setData(bands.upper);
          indicatorSeries.boll[1].setData(bands.mid);
          indicatorSeries.boll[2].setData(bands.lower);
          if (indicatorSeries.boll[3]) indicatorSeries.boll[3].setData(bands.upper);
          if (indicatorSeries.boll[4]) indicatorSeries.boll[4].setData(bands.lower);
        }
        if (ind.supertrend && indicatorSeries.supertrend) {
          var stR = resolveSupertrendCfg(ind);
          try {
            indicatorSeries.supertrend.applyOptions({
              color: stR.color,
              lineWidth: stR.lineWidth,
              lineStyle: stR.lineStyle,
            });
          } catch (e) {}
          indicatorSeries.supertrend.setData(computeSupertrend(stR.period, stR.multiplier));
        }
        if (ind.vwap && indicatorSeries.vwap) {
          var vcfgV = resolveVwapCfg(ind);
          try {
            indicatorSeries.vwap.applyOptions({
              color: vcfgV.color,
              lineWidth: vcfgV.lineWidth,
              lineStyle: vcfgV.lineStyle,
            });
          } catch (e) {}
          indicatorSeries.vwap.setData(computeVWAP(vcfgV.length));
        }
        syncMainIndicatorLineGate();
      }

      function updateSubIndicators(ind) {
        if (!ind) return;
        if (ind.vol && subSeries.vol) {
          subSeries.vol.setData(data.map((c) => ({
            time: c.time,
            value: c.volume || 0,
            color: c.close >= c.open ? '${colors.status.success}' : '${colors.status.error}',
          })));
        }
        if (ind.rsi && subSeries.rsi) {
          if (Array.isArray(ind.rsiRows) && ind.rsiRows.length) {
            ind.rsiRows.forEach(function(row, slot) {
              if (!row || !row.enabled) return;
              var series = subSeries.rsi[String(slot)];
              if (!series) return;
              var period = parseInt(String(row.period), 10) || 0;
              if (period <= 0) return;
              var src = row.source || 'close';
              var rlw = parseInt(String(row.lineWidth != null ? row.lineWidth : 1), 10);
              if (!Number.isFinite(rlw) || rlw < 1) rlw = 1;
              if (rlw > 4) rlw = 4;
              var rls = Number(row.lineStyle);
              if (!Number.isFinite(rls) || rls < 0 || rls > 4) rls = 0;
              try {
                series.applyOptions({
                  color: row.color || '#38bdf8',
                  lineWidth: rlw,
                  lineStyle: rls,
                });
              } catch (e) {}
              series.setData(padSeriesToAllTimes(computeRSI(period, src)));
            });
          } else if (subSeries.rsi.legacy) {
            subSeries.rsi.legacy.setData(padSeriesToAllTimes(computeRSI(14, 'close')));
          }
        }
        if (ind.cci && subSeries.cci) {
          subSeries.cci.setData(padSeriesToAllTimes(computeCCI(20)));
        }
        if (ind.macd && subSeries.macd) {
          const macd = computeMACD();
          subSeries.macd.macdSeries.setData(padSeriesToAllTimes(macd.macd));
          subSeries.macd.signalSeries.setData(padSeriesToAllTimes(macd.signal));
          const histColored = macd.hist.map((h) => ({
            time: h.time,
            value: h.value,
            color: h.value >= 0 ? '${colors.status.success}' : '${colors.status.error}',
          }));
          subSeries.macd.histSeries.setData(padSeriesToAllTimes(histColored, true));
        }
      }

      rebuildIndicators(payload.indicators || {});

      var lastIndicatorJson = JSON.stringify(payload.indicators || {});
      window.__setIndicators = (nextIndicators) => {
        var nextJson = JSON.stringify(nextIndicators || {});
        if (nextJson === lastIndicatorJson) return;
        lastIndicatorJson = nextJson;
        payload.indicators = nextIndicators || {};
        rebuildIndicators(payload.indicators);
        renderIndicatorValues();
      };

      function getActiveSeries() {
        return currentChartMode === 'line' ? smoothLineSeries : candleSeries;
      }

      function applyOrderLines() {
        // Remove existing entry line from both series (in case mode changed)
        if (entryLineRef) {
          try { candleSeries.removePriceLine(entryLineRef); } catch (e) {}
          try { smoothLineSeries.removePriceLine(entryLineRef); } catch (e) {}
          entryLineRef = null;
        }
        // Remove existing liq line from both series
        if (liqLineRef) {
          try { candleSeries.removePriceLine(liqLineRef); } catch (e) {}
          try { smoothLineSeries.removePriceLine(liqLineRef); } catch (e) {}
          liqLineRef = null;
        }
        // Remove existing limit lines from both series
        limitLineRefs.forEach((l) => {
          try { candleSeries.removePriceLine(l); } catch (e) {}
          try { smoothLineSeries.removePriceLine(l); } catch (e) {}
        });
        limitLineRefs = [];
        
        if (!showOrderLines) return;
        
        const activeSeries = getActiveSeries();
        
        // Create entry line (only one). "Avg." is meaningful (the
        // PnL-weighted average entry that shifts as the user stacks
        // orders), so the label stays. The previous "kissing candles"
        // complaint is instead handled by a bigger rightOffset at
        // chart creation — the latest bar now lands a few bars
        // further from the right price scale, so pills like "Avg.",
        // "Liq." have breathing room without eating into candle
        // territory.
        if (Number.isFinite(payload.entryPx)) {
          entryLineRef = activeSeries.createPriceLine({
            price: payload.entryPx,
            color: payload.entryColor || '${colors.text.tertiary}',
            lineWidth: 1,
            lineStyle: 0,
            axisLabelVisible: true,
            title: 'Avg.',
          });
        }

        // Create HL-reported liquidation line — always red, dashed, so
        // it reads as "danger" at a glance regardless of long/short
        // side. Same renderer as entry/limit lines so it follows the
        // same mode-switch + axis-label behavior.
        if (Number.isFinite(payload.liqPx)) {
          liqLineRef = activeSeries.createPriceLine({
            price: payload.liqPx,
            color: '${colors.status.error}',
            lineWidth: 1,
            lineStyle: 2,
            axisLabelVisible: true,
            title: 'Liq.',
          });
        }

        // Create limit / TP / SL order lines. All dashed to stay
        // visually distinct from the solid entry ("Avg.") line.
        // Color + title convey semantic meaning:
        //   - tp   → green dashed, "Tp" title (take-profit target)
        //   - sl   → red dashed,   "Sl" title (stop-loss trigger)
        //   - buy  → gold dashed,  "B"  title (limit buy)
        //   - sell → red dashed,   "S"  title (limit sell)
        // Back-compat: if a caller still sends the legacy {px, isBuy}
        // shape (or even the older flat limitPrices array), we map
        // it into {px, kind} transparently.
        var orders = Array.isArray(payload.limitOrders)
          ? payload.limitOrders
          : (Array.isArray(payload.limitPrices)
              ? payload.limitPrices.map(function(px){ return { px: px, kind: 'buy' }; })
              : []);
        orders.forEach(function(entry){
          if (!entry) return;
          var px = typeof entry.px === 'number' ? entry.px : parseFloat(String(entry.px));
          if (!Number.isFinite(px)) return;
          var kind = entry.kind;
          if (!kind) {
            kind = entry.isBuy ? 'buy' : 'sell';
          }
          var color, title;
          if (kind === 'tp') {
            color = '${colors.status.success}';
            title = 'Tp';
          } else if (kind === 'sl') {
            color = '${colors.status.error}';
            title = 'Sl';
          } else if (kind === 'sell') {
            color = '${colors.status.error}';
            title = 'S';
          } else {
            color = '${colors.accent.goldDark}';
            title = 'B';
          }
          var line = activeSeries.createPriceLine({
            price: px,
            color: color,
            lineWidth: 1,
            lineStyle: 2,
            axisLabelVisible: true,
            title: title,
          });
          limitLineRefs.push(line);
        });
      }
      applyOrderLines();
      var lastOrderLinesJson = null;
      window.__setOrderLines = (next) => {
        const cfg = next || {};
        const rawEntry = cfg.entryPx;
        const entry = typeof rawEntry === 'number' ? rawEntry : parseFloat(String(rawEntry));
        const nextEntry = Number.isFinite(entry) ? cx(entry) : null;
        const nextEntryColor = typeof cfg.entryColor === 'string' ? cfg.entryColor : payload.entryColor;
        const rawLiq = cfg.liqPx;
        const liq = typeof rawLiq === 'number' ? rawLiq : parseFloat(String(rawLiq));
        const nextLiq = Number.isFinite(liq) && liq > 0 ? cx(liq) : null;
        const rawLimitOrders = Array.isArray(cfg.limitOrders)
          ? cfg.limitOrders
          : (Array.isArray(cfg.limitPrices)
              ? cfg.limitPrices.map(function(px){ return { px: px, kind: 'buy' }; })
              : []);
        const nextLimitOrders = rawLimitOrders
          .map(function(entry){
            if (entry == null) return null;
            const raw = typeof entry === 'object' ? entry.px : entry;
            const p = typeof raw === 'number' ? raw : parseFloat(String(raw));
            if (!Number.isFinite(p)) return null;
            let kind = entry && entry.kind;
            if (kind !== 'tp' && kind !== 'sl' && kind !== 'buy' && kind !== 'sell') {
              // Back-compat: normalize legacy {isBuy} shape to the new
              // kind enum. Unknown values fall through to 'sell' so
              // that orders don't all collapse to buy-gold by default.
              kind = entry && entry.isBuy ? 'buy' : 'sell';
            }
            return { px: cx(p), kind: kind };
          })
          .filter(function(e){ return e !== null; });
        // Short-circuit when the incoming config is identical to the last
        // applied one. applyOrderLines() otherwise removes and recreates
        // price lines on every call, and each recreation can bump the
        // right-price-scale width by a pixel — visible as a horizontal
        // shake of the candles right after the overlay lifts.
        const nextJson = JSON.stringify({ entry: nextEntry, color: nextEntryColor, liq: nextLiq, limits: nextLimitOrders });
        if (nextJson === lastOrderLinesJson) return;
        lastOrderLinesJson = nextJson;
        payload.entryPx = nextEntry;
        payload.entryColor = nextEntryColor;
        payload.liqPx = nextLiq;
        payload.limitOrders = nextLimitOrders;
        applyOrderLines();
      };

      window.__setTradeMarkers = (cfg) => {
        cfg = cfg || {};
        showTradeMarkers = cfg.show === true;
        tradeMarkersList = Array.isArray(cfg.markers) ? cfg.markers : [];
        requestAnimationFrame(function() {
          var r = chart.timeScale().getVisibleRange();
          if (r) updateRangeInfo(r);
          else updateTradeMarkers();
        });
      };

      const crosshairDot = document.getElementById('crosshair-dot');
      const futureTimeLabel = document.getElementById('future-time-label');
      const drawLayer = document.getElementById('draw-layer');
      const drawStartDot = document.getElementById('draw-start');
      const drawEndDot = document.getElementById('draw-end');
      // OHLCV HUD DOM handles — cached once so the crosshair move
      // callback doesn't do getElementById on every frame.
      const hudEl = document.getElementById('ohlcv-hud');
      const hudO = document.getElementById('hud-o');
      const hudH = document.getElementById('hud-h');
      const hudL = document.getElementById('hud-l');
      const hudC = document.getElementById('hud-c');
      const hudChg = document.getElementById('hud-chg');
      const hudV = document.getElementById('hud-v');
      const hudN = document.getElementById('hud-n');
      function fmtHudPrice(p) {
        if (!Number.isFinite(p)) return '--';
        return CX_SYM + p.toFixed(CX_DEC);
      }
      function fmtHudCompact(n, decimals) {
        if (!Number.isFinite(n)) return '--';
        var d = (typeof decimals === 'number') ? decimals : 2;
        var abs = Math.abs(n);
        if (abs >= 1e9) return (n / 1e9).toFixed(d) + 'B';
        if (abs >= 1e6) return (n / 1e6).toFixed(d) + 'M';
        if (abs >= 1e3) return (n / 1e3).toFixed(d) + 'K';
        if (abs >= 1) return n.toFixed(d);
        return n.toFixed(4);
      }
      function fmtHudTrades(n) {
        if (!Number.isFinite(n)) return '--';
        if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
        if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
        return String(Math.round(n));
      }
      function fmtHudChangePct(pct) {
        if (!Number.isFinite(pct)) return '--';
        var sign = pct >= 0 ? '+' : '';
        return sign + pct.toFixed(2) + '%';
      }
      // Binary search the sorted data array by time. LWC's crosshair
      // param.time matches the time of the exact bar beneath the cursor,
      // so this is an O(log n) lookup per crosshair move frame.
      function findCandleByTime(t) {
        if (!Array.isArray(data) || data.length === 0 || t == null) return null;
        var lo = 0, hi = data.length - 1;
        while (lo <= hi) {
          var mid = (lo + hi) >> 1;
          var mt = data[mid].time;
          if (mt === t) return data[mid];
          if (mt < t) lo = mid + 1;
          else hi = mid - 1;
        }
        return null;
      }
      function hideHud() {
        if (hudEl && hudEl.classList.contains('open')) hudEl.classList.remove('open');
      }
      // Two placements depending on layout:
      //  - Inline mode: stack HUD vertically BELOW the top-left corner
      //    (below ind-toggle when panel is closed; below the full
      //    indicator-values stack when open). Never overlaps them.
      //  - Expanded mode: RN paints system icons (close button etc.)
      //    right on top of the WebView's top area, so stacking the HUD
      //    below the arrow would get hidden by those overlays. Instead
      //    place it HORIZONTALLY to the right of the arrow (or past the
      //    indicator panel when open), keeping it on the same top row.
      function positionHud() {
        if (!hudEl) return;
        var isExpanded = document.body.classList.contains('expanded');
        var indVals = document.getElementById('indicator-values');
        var panelOpen = !!(indVals && indVals.classList.contains('visible'));
        if (isExpanded) {
          var left = 40;
          if (panelOpen) {
            var w = indVals.offsetWidth || 0;
            if (w > 0) left = 24 + w + 14;
          }
          hudEl.style.top = '1px';
          hudEl.style.left = left + 'px';
          hudEl.style.maxWidth = 'calc(100% - ' + (left + 4) + 'px)';
        } else {
          var baseTop = 22;
          if (panelOpen) {
            var h = indVals.offsetHeight || 0;
            if (h > 0) baseTop = 1 + h + 4;
          }
          hudEl.style.top = baseTop + 'px';
          hudEl.style.left = '4px';
          hudEl.style.maxWidth = 'calc(100% - 8px)';
        }
      }
      // Signal from RN when this WebView is mounted inside the
      // expanded (landscape) modal. Triggers the alternate HUD layout.
      window.__setExpandedMode = function(flag) {
        try {
          if (flag) document.body.classList.add('expanded');
          else document.body.classList.remove('expanded');
        } catch (e) {}
        try { positionHud(); } catch (e) {}
      };
      function updateHud(param) {
        if (!hudEl) return;
        if (!showOhlcvHud) { hideHud(); return; }
        // Only show while the LWC crosshair is actively locked on a bar
        // (param.point is the pixel cursor, param.time is the bar's time).
        var t = param && param.time;
        if (!t || !param.point) { hideHud(); return; }
        // O/H/L/C: prefer LWC's seriesData (authoritative for the bar
        // under the cursor). V/N: pulled from our local data array,
        // since LWC doesn't carry volume/trades in its series payload.
        var sd = (param.seriesData && candleSeries) ? param.seriesData.get(candleSeries) : null;
        var full = findCandleByTime(t);
        var open = sd ? sd.open : (full ? full.open : NaN);
        var high = sd ? sd.high : (full ? full.high : NaN);
        var low = sd ? sd.low : (full ? full.low : NaN);
        var close = sd ? sd.close : (full ? full.close : NaN);
        if (!Number.isFinite(close)) { hideHud(); return; }
        var volume = full && Number.isFinite(full.volume) ? full.volume : NaN;
        var trades = full && Number.isFinite(full.trades) ? full.trades : NaN;
        var changePct = Number.isFinite(open) && open !== 0 ? ((close - open) / open) * 100 : NaN;
        var up = Number.isFinite(changePct) ? changePct >= 0 : (close >= open);
        if (hudO) hudO.textContent = fmtHudPrice(open);
        if (hudH) hudH.textContent = fmtHudPrice(high);
        if (hudL) hudL.textContent = fmtHudPrice(low);
        if (hudC) {
          hudC.textContent = fmtHudPrice(close);
          hudC.classList.toggle('up', up);
          hudC.classList.toggle('down', !up);
        }
        if (hudChg) {
          hudChg.textContent = fmtHudChangePct(changePct);
          hudChg.classList.toggle('up', up);
          hudChg.classList.toggle('down', !up);
        }
        if (hudV) hudV.textContent = fmtHudCompact(volume, 2);
        if (hudN) hudN.textContent = fmtHudTrades(trades);
        // Re-position every frame the HUD is shown — the indicator
        // panel above it can grow/shrink as the user toggles indicator
        // rows mid-crosshair, so a one-shot positioning isn't enough.
        positionHud();
        if (!hudEl.classList.contains('open')) hudEl.classList.add('open');
      }
      function applyCrosshairStyle() {
        const active = drawingEnabled && !!activeTool;
        chart.applyOptions({
          crosshair: {
            vertLine: {
              color: active ? '#60a5fa' : '${colors.text.tertiary}',
              style: active ? 2 : 0,
            },
            horzLine: {
              color: active ? '#60a5fa' : '${colors.text.tertiary}',
              style: active ? 2 : 0,
            },
          },
        });
        if (crosshairDot) {
          crosshairDot.style.opacity = active ? 1 : 0;
        }
        if (drawLayer) {
          drawLayer.style.pointerEvents = active ? 'auto' : 'none';
        }
        if (!active) {
          if (drawStartDot) drawStartDot.style.opacity = 0;
          if (drawEndDot) drawEndDot.style.opacity = 0;
        }
      }
      applyCrosshairStyle();

      function setDot(el, x, y, visible, size) {
        if (!el) return;
        el.style.opacity = visible ? 1 : 0;
        el.style.width = size + 'px';
        el.style.height = size + 'px';
        el.style.left = x + 'px';
        el.style.top = y + 'px';
      }

      var drawDpr = window.devicePixelRatio || 1;
      function resizeDrawLayer() {
        if (!drawLayer) return;
        const w = mainWrap.clientWidth || mainChartEl.clientWidth || 0;
        const h = mainWrap.clientHeight || 0;
        drawLayer.width = w * drawDpr;
        drawLayer.height = h * drawDpr;
        drawLayer.style.width = w + 'px';
        drawLayer.style.height = h + 'px';
        var ctx = drawLayer.getContext('2d');
        if (ctx) ctx.setTransform(drawDpr, 0, 0, drawDpr, 0, 0);
      }

      function formatFiboPrice(p) {
        if (p >= 1e6) return (p/1e6).toFixed(2)+'M';
        if (p >= 1e3) return (p/1e3).toFixed(1)+'k';
        if (p >= 1) return p.toFixed(2);
        return p.toPrecision(4);
      }

      // Approximate pixel width of one bar, used to extrapolate pixel
      // coordinates for virtual (post-last-candle) times used by
      // drawings that were anchored past the chart's right edge.
      function barStepPx() {
        try {
          var opts = chart.timeScale().options();
          if (opts && Number.isFinite(opts.barSpacing) && opts.barSpacing > 0) {
            return opts.barSpacing;
          }
        } catch (e) {}
        return 8;
      }
      // Seconds between successive bars — derived from the last two
      // candles so drawings extrapolate using the real interval step.
      function barStepSec() {
        if (!data || data.length < 2) return 60;
        var s = data[data.length - 1].time - data[data.length - 2].time;
        return s > 0 ? s : 60;
      }
      function safeTimeToCoord(t) {
        var c = chart.timeScale().timeToCoordinate(t);
        if (c !== null) return c;
        if (!data || data.length < 2) return null;
        var lo = 0, hi = data.length - 1;
        if (t <= data[lo].time) {
          // Before the first bar — extrapolate backwards using barSpacing
          // (same pattern as future-extrapolation below) so drawings that
          // start off the left edge stay anchored while the chart pans.
          var x0 = chart.timeScale().timeToCoordinate(data[lo].time);
          if (x0 === null) return null;
          var back = timeAlign === 'utc-month'
            ? utcCalendarMonthsBetween(t, data[lo].time)
            : (data[lo].time - t) / barStepSec();
          return x0 - back * barStepPx();
        }
        if (t >= data[hi].time) {
          // Past the last bar — extrapolate forward. This lets trend
          // lines / fib levels / rays extend into the empty space to
          // the right of the latest candle and stay attached as the
          // chart pans, instead of getting clamped to the last bar.
          var xN = chart.timeScale().timeToCoordinate(data[hi].time);
          if (xN === null) return null;
          var ahead = timeAlign === 'utc-month'
            ? utcCalendarMonthsBetween(data[hi].time, t)
            : (t - data[hi].time) / barStepSec();
          return xN + ahead * barStepPx();
        }
        while (hi - lo > 1) {
          var mid = (lo + hi) >> 1;
          if (data[mid].time <= t) lo = mid; else hi = mid;
        }
        var tLo = data[lo].time, tHi = data[hi].time;
        var xLo = chart.timeScale().timeToCoordinate(tLo);
        var xHi = chart.timeScale().timeToCoordinate(tHi);
        if (xLo === null || xHi === null) return null;
        var frac = (tHi === tLo) ? 0 : (t - tLo) / (tHi - tLo);
        return xLo + (xHi - xLo) * frac;
      }
      // coordinateToTime returns null for x values past the last bar
      // (anywhere inside rightOffset's empty space). For drawing input
      // we want to accept those clicks and produce a "virtual" future
      // time we can store and later map back with safeTimeToCoord.
      function coordinateToTimeExt(x) {
        var t = chart.timeScale().coordinateToTime(x);
        if (t !== null && t !== undefined) return t;
        if (!data || data.length < 2) return null;
        var lastT = data[data.length - 1].time;
        var lastX = chart.timeScale().timeToCoordinate(lastT);
        if (lastX === null) return null;
        var bars = (x - lastX) / barStepPx();
        if (timeAlign === 'utc-month') {
          bars = Math.round(bars);
          if (bars < 0) bars = 0;
          return extrapolateTimeFromLast(lastT, bars);
        }
        return lastT + bars * barStepSec();
      }

      function drawOneLine(ctx, start, end, tool, color) {
        ctx.save();
        if (tool === 'horizontal') {
          // Horizontal S/R line: always draws at start.price across the
          // full drawable width (minus the right price-scale gutter), so
          // the end points Y is ignored. This also makes the live
          // preview snap horizontal while the user is still dragging.
          var y = candleSeries.priceToCoordinate(start.price);
          if (y === null) { ctx.restore(); return; }
          var priceScaleW = 90;
          try { var psw = chart.priceScale('right').width(); if (psw > 0) priceScaleW = psw + 4; } catch(e) {}
          var dlw = drawLayer.width / drawDpr;
          var c = color || '#60a5fa';
          ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.setLineDash([]);
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(dlw - priceScaleW, y); ctx.stroke();
          ctx.restore();
          return;
        }
        const x1 = safeTimeToCoord(start.time);
        const x2 = safeTimeToCoord(end.time);
        const y1 = candleSeries.priceToCoordinate(start.price);
        const y2 = candleSeries.priceToCoordinate(end.price);
        if (x1 === null || x2 === null || y1 === null || y2 === null) { ctx.restore(); return; }
        if (tool === 'fibo') {
          const fiboLevels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
          const fiboColors = ['#ef4444','#f59e0b','#eab308','#34d399','#60a5fa','#a78bfa','#ec4899'];
          const pd = end.price - start.price;
          var priceScaleW = 90;
          try { var psw = chart.priceScale('right').width(); if (psw > 0) priceScaleW = psw + 4; } catch(e) {}
          fiboLevels.forEach(function(lv, i) {
            var p = start.price + pd * lv;
            var yy = candleSeries.priceToCoordinate(p);
            if (yy === null) return;
            ctx.strokeStyle = fiboColors[i];
            ctx.lineWidth = 1;
            ctx.setLineDash([]);
            var dlw = drawLayer.width / drawDpr;
            ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(dlw - priceScaleW, yy); ctx.stroke();
            ctx.fillStyle = fiboColors[i];
            ctx.font = '500 12px -apple-system, BlinkMacSystemFont, Inter, sans-serif';
            var label = formatFiboPrice(p) + '  ' + (lv*100).toFixed(1)+'%';
            var tw = ctx.measureText(label).width;
            ctx.fillText(label, dlw - priceScaleW - tw - 6, yy - 5);
          });
        } else {
          var c = color || '#60a5fa';
          ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.setLineDash([]);
          ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        }
        ctx.restore();
      }

      function ptToSegDist(px, py, ax, ay, bx, by) {
        var dx = bx-ax, dy = by-ay, len2 = dx*dx+dy*dy;
        if (len2 === 0) return Math.sqrt((px-ax)*(px-ax)+(py-ay)*(py-ay));
        var t = Math.max(0, Math.min(1, ((px-ax)*dx+(py-ay)*dy)/len2));
        var cx = ax+t*dx, cy = ay+t*dy;
        return Math.sqrt((px-cx)*(px-cx)+(py-cy)*(py-cy));
      }

      function findNearestDrawing(px, py) {
        var threshold = 24;
        for (var i = confirmedDrawings.length-1; i >= 0; i--) {
          var d = confirmedDrawings[i];
          if (d.tool === 'horizontal') {
            var hy = candleSeries.priceToCoordinate(d.start.price);
            if (hy !== null && Math.abs(py - hy) < threshold) return i;
            continue;
          }
          var x1 = safeTimeToCoord(d.start.time);
          var x2 = safeTimeToCoord(d.end.time);
          var y1 = candleSeries.priceToCoordinate(d.start.price);
          var y2 = candleSeries.priceToCoordinate(d.end.price);
          if (x1===null||x2===null||y1===null||y2===null) continue;
          if (d.tool === 'fibo') {
            var fiboLevels = [0,0.236,0.382,0.5,0.618,0.786,1];
            var pd = d.end.price - d.start.price;
            for (var j = 0; j < fiboLevels.length; j++) {
              var p = d.start.price + pd*fiboLevels[j];
              var yy = candleSeries.priceToCoordinate(p);
              if (yy !== null && Math.abs(py-yy) < threshold) return i;
            }
            if (ptToSegDist(px,py,x1,y1,x2,y2) < threshold) return i;
          } else {
            if (ptToSegDist(px,py,x1,y1,x2,y2) < threshold) return i;
          }
        }
        return -1;
      }

      function findNearestEndpoint(px, py) {
        var threshold = 28;
        for (var i = confirmedDrawings.length-1; i >= 0; i--) {
          var d = confirmedDrawings[i];
          // Horizontal lines have no user-facing endpoints (they span
          // the full chart width). Same as fibo — users reposition by
          // deleting and re-drawing.
          if (d.tool === 'fibo' || d.tool === 'horizontal') continue;
          var sx = safeTimeToCoord(d.start.time);
          var sy = candleSeries.priceToCoordinate(d.start.price);
          var ex = safeTimeToCoord(d.end.time);
          var ey = candleSeries.priceToCoordinate(d.end.price);
          if (sx !== null && sy !== null && Math.sqrt((px-sx)*(px-sx)+(py-sy)*(py-sy)) < threshold) return { idx: i, ep: 'start' };
          if (ex !== null && ey !== null && Math.sqrt((px-ex)*(px-ex)+(py-ey)*(py-ey)) < threshold) return { idx: i, ep: 'end' };
        }
        return null;
      }

      function redrawAllDrawings(previewEnd) {
        if (!drawLayer) return;
        var ctx = drawLayer.getContext('2d');
        if (!ctx) return;
        var cw = drawLayer.width / drawDpr, ch = drawLayer.height / drawDpr;
        ctx.clearRect(0, 0, cw, ch);
        confirmedDrawings.forEach(function(d) { drawOneLine(ctx, d.start, d.end, d.tool, d.color); });
        var start = lineStart; var end = previewEnd || lineEnd;
        if (start && end) {
          drawOneLine(ctx, start, end, activeTool, activeColor);
          if (activeTool === 'horizontal') {
            // Horizontal line has no endpoint handles — hide the dots.
            if (drawStartDot) drawStartDot.style.opacity = 0;
            if (drawEndDot) drawEndDot.style.opacity = 0;
          } else {
            var x1 = safeTimeToCoord(start.time);
            var x2 = safeTimeToCoord(end.time);
            var y1 = candleSeries.priceToCoordinate(start.price);
            var y2 = candleSeries.priceToCoordinate(end.price);
            if (x1 !== null && y1 !== null) setDot(drawStartDot, x1, y1, true, isDrawing ? 12 : 8);
            if (x2 !== null && y2 !== null) setDot(drawEndDot, x2, y2, true, 8);
          }
        } else {
          var dotIdx = editingDrawingIdx >= 0 ? editingDrawingIdx : selectedDrawingIdx;
          if (dotIdx >= 0 && dotIdx < confirmedDrawings.length && confirmedDrawings[dotIdx].tool !== 'fibo' && confirmedDrawings[dotIdx].tool !== 'horizontal') {
            var dd = confirmedDrawings[dotIdx];
            var dsx = safeTimeToCoord(dd.start.time);
            var dsy = candleSeries.priceToCoordinate(dd.start.price);
            var dex = safeTimeToCoord(dd.end.time);
            var dey = candleSeries.priceToCoordinate(dd.end.price);
            if (dsx !== null && dsy !== null) setDot(drawStartDot, dsx, dsy, true, 10);
            if (dex !== null && dey !== null) setDot(drawEndDot, dex, dey, true, 10);
          } else {
            if (drawStartDot) drawStartDot.style.opacity = 0;
            if (drawEndDot) drawEndDot.style.opacity = 0;
          }
        }
      }

      var drawConfirmEl = document.getElementById('draw-confirm');
      var drawYesBtn = document.getElementById('draw-yes');
      var drawNoBtn = document.getElementById('draw-no');
      var drawColorsEl = document.getElementById('draw-colors');
      var drawColorBtn = document.getElementById('draw-color-btn');
      var colorSwatchEl = drawColorBtn ? drawColorBtn.querySelector('.swatch') : null;
      var colorsOpen = false;

      function updateSwatchColor(c) {
        if (colorSwatchEl) colorSwatchEl.style.background = c;
      }

      function buildColorDots(selected) {
        if (!drawColorsEl) return;
        drawColorsEl.innerHTML = '';
        drawColors.forEach(function(c) {
          var dot = document.createElement('div');
          dot.className = 'draw-color-dot' + (c === selected ? ' active' : '');
          dot.style.background = c;
          dot.addEventListener('click', function(ev) {
            ev.stopPropagation();
            if (selectedDrawingIdx >= 0) {
              confirmedDrawings[selectedDrawingIdx].color = c;
              notifyDrawingsChanged();
            } else {
              activeColor = c;
            }
            updateSwatchColor(c);
            buildColorDots(c);
            redrawAllDrawings();
          });
          drawColorsEl.appendChild(dot);
        });
      }

      if (drawColorBtn) {
        drawColorBtn.addEventListener('click', function(ev) {
          ev.stopPropagation();
          colorsOpen = !colorsOpen;
          if (drawColorsEl) drawColorsEl.className = colorsOpen ? 'open' : '';
        });
      }

      function showDrawConfirm(x, y, preselectedColor, toolType) {
        if (!drawConfirmEl) return;
        pendingConfirm = true;
        colorsOpen = false;
        var isFibo = toolType === 'fibo';
        if (drawColorsEl) drawColorsEl.className = '';
        if (isFibo) {
          if (drawColorBtn) drawColorBtn.style.display = 'none';
        } else {
          if (drawColorBtn) drawColorBtn.style.display = 'flex';
          var sc = preselectedColor || activeColor;
          updateSwatchColor(sc);
          buildColorDots(sc);
        }
        drawConfirmEl.style.display = 'flex';
        var w = drawLayer ? drawLayer.width / drawDpr : 300;
        var h = drawLayer ? drawLayer.height / drawDpr : 300;
        var tipW = 105; var tipH = 42;
        var posX = Math.min(w - tipW - 6, Math.max(6, x - tipW / 2));
        var posY = y + 16;
        if (posY + tipH > h - 6) posY = Math.max(6, y - tipH - 10);
        drawConfirmEl.style.left = posX + 'px';
        drawConfirmEl.style.top = posY + 'px';
      }
      function hideDrawConfirm() {
        pendingConfirm = false;
        colorsOpen = false;
        if (drawColorsEl) drawColorsEl.className = '';
        if (drawConfirmEl) drawConfirmEl.style.display = 'none';
      }
      if (drawYesBtn) drawYesBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        var changed = false;
        if (selectedDrawingIdx >= 0) {
          changed = true;
          selectedDrawingIdx = -1;
        } else {
          if (lineStart && lineEnd) { confirmedDrawings.push({ start:{time:lineStart.time,price:lineStart.price}, end:{time:lineEnd.time,price:lineEnd.price}, tool: activeTool, color: activeColor }); changed = true; }
          lineStart = null; lineEnd = null;
          if (drawStartDot) drawStartDot.style.opacity = 0;
          if (drawEndDot) drawEndDot.style.opacity = 0;
        }
        hideDrawConfirm(); redrawAllDrawings();
        if (changed) notifyDrawingsChanged();
      });
      if (drawNoBtn) drawNoBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        var changed = false;
        if (selectedDrawingIdx >= 0) {
          confirmedDrawings.splice(selectedDrawingIdx, 1);
          selectedDrawingIdx = -1;
          changed = true;
        } else {
          lineStart = null; lineEnd = null;
          if (drawStartDot) drawStartDot.style.opacity = 0;
          if (drawEndDot) drawEndDot.style.opacity = 0;
        }
        hideDrawConfirm(); redrawAllDrawings();
        if (changed) notifyDrawingsChanged();
      });





      const indicatorValuesEl = document.getElementById('indicator-values');
      const indValuesStackEl = document.getElementById('ind-values-stack');
      const indToggleEl = document.getElementById('ind-toggle');
      var indValuesOpen = false;

      const legacyEmaColorsMap = {
        7: '#ef4444', 20: '#f59e0b', 50: '#a855f7', 100: '#22c55e', 200: '#e5e7eb',
      };
      const legacyMaColorsMap = {
        7: '#f97316', 20: '#60a5fa', 50: '#34d399', 100: '#facc15', 200: '#f472b6',
      };

      function getEmaAtIndex(period, source, idx) {
        var src = source || 'close';
        if (idx < period - 1) return null;
        const k = 2 / (period + 1);
        let ema = candleField(data[0], src);
        for (let i = 1; i <= idx; i++) {
          ema = candleField(data[i], src) * k + ema * (1 - k);
        }
        return ema;
      }

      function getSmaAtIndex(period, source, idx) {
        var src = source || 'close';
        if (idx < period - 1) return null;
        let sum = 0;
        for (let i = idx - period + 1; i <= idx; i++) {
          sum += candleField(data[i], src);
        }
        return sum / period;
      }

      function formatIndPill(tagColor, tagLabel, valueStr) {
        return (
          '<span class="ind-val ind-val-pill">' +
          '<span class="ind-val-tag" style="color:' + tagColor + '">' + tagLabel + ':</span>' +
          '<span class="ind-val-num" style="color:' + tagColor + '">' + valueStr + '</span>' +
          '</span>'
        );
      }

      var IND_EYE_SVG_OPEN =
        '<svg class="ind-eye-open" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';
      var IND_EYE_SVG_OFF =
        '<svg class="ind-eye-off" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

      function formatIndRowHtml(group, pills) {
        if (!pills || !pills.length) return '';
        var shown = mainIndicatorLineGroupShown(group);
        var eyeCls = shown ? '' : ' off';
        return (
          '<div class="ind-row">' +
          '<span class="ind-row-pills">' +
          pills.join('') +
          '<button type="button" class="ind-row-eye' +
          eyeCls +
          '" data-ind-group="' +
          group +
          '">' +
          IND_EYE_SVG_OPEN +
          IND_EYE_SVG_OFF +
          '</button></span></div>'
        );
      }

      function renderIndicatorValues() {
        if (!indicatorValuesEl || !indValuesOpen || !data.length) return;
        var candleIdx = data.length - 1;
        var rows = [];
        var ind = payload.indicators || {};

        var emaRow = [];
        if (Array.isArray(ind.emaRows) && ind.emaRows.length) {
          var emaRaw = [];
          ind.emaRows.forEach(function(row, slot) {
            if (!row || !row.enabled) return;
            var period = parseInt(String(row.period), 10) || 0;
            if (period <= 0) return;
            var src = row.source || 'close';
            var val = getEmaAtIndex(period, src, candleIdx);
            var col = row.color || '${colors.accent.gold}';
            if (val !== null) emaRaw.push({ period: period, slot: slot, col: col, val: val });
          });
          emaRaw.sort(function(a, b) {
            if (a.period !== b.period) return a.period - b.period;
            return a.slot - b.slot;
          });
          var emaDup = {};
          emaRaw.forEach(function(item) {
            var n = (emaDup[item.period] || 0) + 1;
            emaDup[item.period] = n;
            var eSuffix = n > 1 ? '#' + n : '';
            emaRow.push(formatIndPill(item.col, 'E' + item.period + eSuffix, item.val.toFixed(pricePrecision)));
          });
        } else if (ind.ema) {
          [7, 20, 50, 100, 200].forEach(function(p) {
            if (!ind.ema[p]) return;
            var val = getEmaAtIndex(p, 'close', candleIdx);
            if (val !== null) {
              emaRow.push(formatIndPill(legacyEmaColorsMap[p], 'E' + p, val.toFixed(pricePrecision)));
            }
          });
        }
        if (emaRow.length) rows.push({ g: 'ema', pills: emaRow });

        var maRow = [];
        if (Array.isArray(ind.maRows) && ind.maRows.length) {
          var maRaw = [];
          ind.maRows.forEach(function(row, slot) {
            if (!row || !row.enabled) return;
            var period = parseInt(String(row.period), 10) || 0;
            if (period <= 0) return;
            var src = row.source || 'close';
            var val = getSmaAtIndex(period, src, candleIdx);
            var col = row.color || '${colors.accent.blue}';
            if (val !== null) maRaw.push({ period: period, slot: slot, col: col, val: val });
          });
          maRaw.sort(function(a, b) {
            if (a.period !== b.period) return a.period - b.period;
            return a.slot - b.slot;
          });
          var maDup = {};
          maRaw.forEach(function(item) {
            var n = (maDup[item.period] || 0) + 1;
            maDup[item.period] = n;
            var mSuffix = n > 1 ? '#' + n : '';
            maRow.push(formatIndPill(item.col, 'M' + item.period + mSuffix, item.val.toFixed(pricePrecision)));
          });
        } else if (ind.ma) {
          [7, 20, 50, 100, 200].forEach(function(p) {
            if (!ind.ma[p]) return;
            var val = getSmaAtIndex(p, 'close', candleIdx);
            if (val !== null) {
              maRow.push(formatIndPill(legacyMaColorsMap[p], 'M' + p, val.toFixed(pricePrecision)));
            }
          });
        }
        if (maRow.length) rows.push({ g: 'ma', pills: maRow });

        if (ind.supertrend) {
          try {
            var stCfgP = resolveSupertrendCfg(ind);
            var stLbl =
              'ST(' + stCfgP.period + ',' + (stCfgP.multiplier % 1 === 0 ? stCfgP.multiplier : stCfgP.multiplier.toFixed(2)) + ')';
            var stVal = null;
            if (indicatorSeries.supertrend && typeof indicatorSeries.supertrend.data === 'function') {
              var stData = indicatorSeries.supertrend.data();
              if (stData && stData.length) {
                var stLast = stData[stData.length - 1];
                if (stLast && Number.isFinite(stLast.value)) stVal = stLast.value;
              }
            }
            if (stVal === null && data.length) {
              var stComp = computeSupertrend(stCfgP.period, stCfgP.multiplier);
              if (stComp && stComp.length) {
                var stLastC = stComp[stComp.length - 1];
                if (stLastC && Number.isFinite(stLastC.value)) stVal = stLastC.value;
              }
            }
            if (Number.isFinite(stVal)) {
              rows.push({
                g: 'supertrend',
                pills: [formatIndPill(stCfgP.color, stLbl, stVal.toFixed(pricePrecision))],
              });
            }
          } catch(e) {}
        }

        if (ind.vwap) {
          var vcfgP = resolveVwapCfg(ind);
          var vL = vcfgP.length;
          var vwArr = computeVWAP(vL);
          if (vwArr && vwArr.length) {
            var vLast = vwArr[vwArr.length - 1];
            if (Number.isFinite(vLast.value)) {
              rows.push({
                g: 'vwap',
                pills: [
                  formatIndPill(vcfgP.color, 'VWAP(' + vL + ')', vLast.value.toFixed(pricePrecision)),
                ],
              });
            }
          }
        }

        if (ind.boll) {
          var bcfg3 = resolveBollCfg(ind);
          var bPeriod = bcfg3.length;
          var bMult = bcfg3.multiplier;
          if (candleIdx >= bPeriod - 1) {
            var bSum = 0, bSumSq = 0;
            for (var bi = candleIdx - bPeriod + 1; bi <= candleIdx; bi++) {
              var bv = data[bi].close;
              bSum += bv; bSumSq += bv * bv;
            }
            var bMean = bSum / bPeriod;
            var bStd = Math.sqrt(Math.max(0, bSumSq / bPeriod - bMean * bMean));
            var bUp = bMean + bMult * bStd;
            var bDn = bMean - bMult * bStd;
            var bollLbl = '(' + bPeriod + ', ' + bMult + ')';
            var rowBoll = [formatIndPill('#94a3b8', 'BOLL', bollLbl)];
            if (bcfg3.showUpper) rowBoll.push(formatIndPill(bcfg3.upperColor, 'UP', bUp.toFixed(pricePrecision)));
            if (bcfg3.showMid) rowBoll.push(formatIndPill(bcfg3.midColor, 'MB', bMean.toFixed(pricePrecision)));
            if (bcfg3.showLower) rowBoll.push(formatIndPill(bcfg3.lowerColor, 'DN', bDn.toFixed(pricePrecision)));
            rows.push({ g: 'boll', pills: rowBoll });
          }
        }

        var rowsHtml = rows.length
          ? rows
              .map(function(r) {
                return formatIndRowHtml(r.g, r.pills);
              })
              .join('')
          : '';
        if (indValuesStackEl) {
          indValuesStackEl.innerHTML = rowsHtml;
        } else if (indicatorValuesEl) {
          indicatorValuesEl.innerHTML = rowsHtml;
        }
      }

      if (indicatorValuesEl) {
        indicatorValuesEl.addEventListener('click', function(e) {
          var btn = e.target && e.target.closest && e.target.closest('.ind-row-eye');
          if (!btn) return;
          e.stopPropagation();
          e.preventDefault();
          var g = btn.getAttribute('data-ind-group');
          if (g && window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
            window.ReactNativeWebView.postMessage(
              JSON.stringify({ type: 'toggle-indicator-lines', group: g }),
            );
          }
        });
      }

      if (indToggleEl) {
        indToggleEl.addEventListener('click', function() {
          indValuesOpen = !indValuesOpen;
          if (indValuesOpen) {
            indToggleEl.classList.add('open');
            if (indicatorValuesEl) indicatorValuesEl.classList.add('visible');
            renderIndicatorValues();
          } else {
            indToggleEl.classList.remove('open');
            if (indicatorValuesEl) indicatorValuesEl.classList.remove('visible');
          }
          // If the HUD is currently on screen, reflow it to sit
          // below the new top-left content (panel just opened/closed).
          try { if (typeof positionHud === 'function') positionHud(); } catch (e) {}
          if (window.ReactNativeWebView) {
            window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ind-toggle', open: indValuesOpen }));
          }
        });
      }

      // Future-time label: fills in the date/time readout for crosshair
      // positions past the last candle. LWC's native time label only
      // covers x-coords that map to real bar data, so everything inside
      // the rightOffset area comes back blank — but TA users drawing
      // projections (trendline extensions, fibs, indicator cross-over
      // estimates) need to read that projected timestamp. We extrapolate
      // via coordinateToTimeExt and render a small badge anchored at the
      // crosshair's x position, right along the bottom edge where LWC's
      // own label would normally sit.
      function hideFutureTimeLabel() {
        if (futureTimeLabel && futureTimeLabel.classList.contains('visible')) {
          futureTimeLabel.classList.remove('visible');
        }
      }
      function updateFutureTimeLabel(param) {
        if (!futureTimeLabel) return;
        var pt = param && param.point;
        if (!pt || !data || data.length < 2) { hideFutureTimeLabel(); return; }
        // LWC fires a time value when the crosshair is over a real bar.
        // We only take over when there is NO time (past the last bar).
        if (param.time !== undefined && param.time !== null) { hideFutureTimeLabel(); return; }
        var lastT = data[data.length - 1].time;
        var lastX = chart.timeScale().timeToCoordinate(lastT);
        if (lastX === null || pt.x <= lastX + 1) { hideFutureTimeLabel(); return; }
        var step = barStepPx();
        if (!(step > 0)) { hideFutureTimeLabel(); return; }
        // Snap to the nearest virtual bar so each "slot" past the last
        // candle reads as a fixed projected time (e.g. on 1H the label
        // steps lastT+1h, lastT+2h, lastT+3h, ...) — matches LWC's own
        // behavior of showing one timestamp per bar instead of a
        // continuously interpolated value per pixel.
        var barsAhead = Math.round((pt.x - lastX) / step);
        if (barsAhead < 1) barsAhead = 1;
        var t = extrapolateTimeFromLast(lastT, barsAhead);
        if (!Number.isFinite(t)) { hideFutureTimeLabel(); return; }
        var label = formatTimeLabel(t);
        if (!label) { hideFutureTimeLabel(); return; }
        var centerX = lastX + barsAhead * step;
        futureTimeLabel.textContent = label;
        futureTimeLabel.style.left = centerX + 'px';
        if (!futureTimeLabel.classList.contains('visible')) {
          futureTimeLabel.classList.add('visible');
        }
      }

      chart.subscribeCrosshairMove((param) => {
        if (crosshairDot) {
          if (!drawingEnabled) {
            crosshairDot.style.opacity = 0;
          } else {
            const p = param?.point;
            if (p) {
              crosshairDot.style.opacity = 1;
              crosshairDot.style.left = p.x + 'px';
              crosshairDot.style.top = p.y + 'px';
            } else {
              crosshairDot.style.opacity = 0;
            }
          }
        }
        // HUD is independent of drawing mode — it shows whenever the
        // native LWC crosshair is locked on a bar (mouse hover on web,
        // long-press + drag on touch). Hides when the crosshair leaves.
        updateHud(param);
        updateFutureTimeLabel(param);
      });

      if (drawLayer) {
        resizeDrawLayer();
        drawLayer.addEventListener('touchstart', function(e) {
          if (drawingEnabled && activeTool) e.preventDefault();
        }, { passive: false });
        drawLayer.addEventListener('touchmove', function(e) {
          if (isDrawing || (editingDrawingIdx >= 0 && editingEndpoint)) e.preventDefault();
        }, { passive: false });
        drawLayer.addEventListener('pointerdown', (e) => {
          if (!drawingEnabled || !activeTool) return;
          e.preventDefault();
          try { drawLayer.setPointerCapture(e.pointerId); } catch(err) {}
          const rect = drawLayer.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          var nearEp = findNearestEndpoint(x, y);
          if (nearEp) {
            editingDrawingIdx = nearEp.idx;
            editingEndpoint = nearEp.ep;
            selectedDrawingIdx = -1;
            hideDrawConfirm();
            redrawAllDrawings();
            return;
          }
          if (pendingConfirm) return;
          var nearIdx = findNearestDrawing(x, y);
          if (nearIdx >= 0) {
            // Horizontal lines support drag-to-reposition. We start an
            // edit session on the whole drawing (both endpoints move
            // together, Y only). If the user never moves (pure tap)
            // we treat it as a select and show the confirm popup on
            // pointerup — same affordance as trendline/fibo.
            if (confirmedDrawings[nearIdx].tool === 'horizontal') {
              editingDrawingIdx = nearIdx;
              editingEndpoint = 'whole';
              editingDownX = x;
              editingDownY = y;
              editingDidMove = false;
              selectedDrawingIdx = -1;
              hideDrawConfirm();
              redrawAllDrawings();
              return;
            }
            selectedDrawingIdx = nearIdx;
            showDrawConfirm(x, y, confirmedDrawings[nearIdx].color || '#60a5fa', confirmedDrawings[nearIdx].tool);
            redrawAllDrawings();
            return;
          }
          const time = coordinateToTimeExt(x);
          const price = candleSeries.coordinateToPrice(y);
          if (!time || !Number.isFinite(price)) return;
          isDrawing = true;
          lineStart = { time, price };
          lineEnd = null;
          setDot(drawStartDot, x, y, true, 12);
          setDot(drawEndDot, x, y, false, 8);
          redrawAllDrawings({ time, price });
        });
        drawLayer.addEventListener('pointermove', (e) => {
          if (isDrawing || (editingDrawingIdx >= 0 && editingEndpoint)) e.preventDefault();
          const rect = drawLayer.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          if (editingDrawingIdx >= 0 && editingEndpoint) {
            const time = coordinateToTimeExt(x);
            const price = candleSeries.coordinateToPrice(y);
            if (!time || !Number.isFinite(price)) return;
            if (editingEndpoint === 'whole') {
              // Horizontal drag: only Y changes. Stamp start.price and
              // end.price both to the new level so endpoints stay in
              // sync (end.price is ignored at render time anyway but we
              // keep them aligned for persistence).
              var d = confirmedDrawings[editingDrawingIdx];
              if (d && d.tool === 'horizontal') {
                d.start.price = price;
                d.end.price = price;
              }
              if (Math.abs(y - editingDownY) > 3 || Math.abs(x - editingDownX) > 3) editingDidMove = true;
              redrawAllDrawings();
              return;
            }
            confirmedDrawings[editingDrawingIdx][editingEndpoint] = { time, price };
            redrawAllDrawings();
            return;
          }
          if (!drawingEnabled || !activeTool || !isDrawing || !lineStart) return;
          const time = coordinateToTimeExt(x);
          const price = candleSeries.coordinateToPrice(y);
          if (!time || !Number.isFinite(price)) return;
          lastPreviewEnd = { time, price, px: x, py: y };
          redrawAllDrawings({ time, price });
        });
        drawLayer.addEventListener('pointerup', (e) => {
          if (editingDrawingIdx >= 0 && editingEndpoint) {
            const rect = drawLayer.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            const time = coordinateToTimeExt(x);
            const price = candleSeries.coordinateToPrice(y);
            if (editingEndpoint === 'whole') {
              // Horizontal: stamp final Y for both endpoints.
              var dFinal = confirmedDrawings[editingDrawingIdx];
              if (dFinal && dFinal.tool === 'horizontal' && Number.isFinite(price)) {
                dFinal.start.price = price;
                dFinal.end.price = price;
              }
            } else if (time && Number.isFinite(price)) {
              confirmedDrawings[editingDrawingIdx][editingEndpoint] = { time, price };
            }
            var eidx = editingDrawingIdx;
            var wasWhole = editingEndpoint === 'whole';
            var didMove = editingDidMove;
            editingDrawingIdx = -1;
            editingEndpoint = null;
            editingDidMove = false;
            selectedDrawingIdx = eidx;
            redrawAllDrawings();
            var ed = confirmedDrawings[eidx];
            var etx, ety;
            if (wasWhole && ed && ed.tool === 'horizontal') {
              // Anchor the confirm popup at the tap/release position so
              // delete/color buttons land under the finger, not at some
              // off-screen "end.time" coordinate.
              etx = x;
              var hy = candleSeries.priceToCoordinate(ed.start.price);
              ety = (hy !== null) ? hy : y;
            } else {
              var eex = safeTimeToCoord(ed.end.time);
              var eey = candleSeries.priceToCoordinate(ed.end.price);
              etx = (eex !== null) ? eex : drawLayer.width / drawDpr / 2;
              ety = (eey !== null) ? eey : drawLayer.height / drawDpr / 2;
            }
            showDrawConfirm(etx, ety, ed.color || '#60a5fa', ed.tool);
            // Only persist if something actually changed. A pure tap
            // on a horizontal line (no drag) is a select — the layer
            // is visually unchanged so we skip the save roundtrip.
            if (!wasWhole || didMove) notifyDrawingsChanged();
            return;
          }
          if (!drawingEnabled || !activeTool || !isDrawing || !lineStart) return;
          const rect = drawLayer.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          const time = coordinateToTimeExt(x);
          const price = candleSeries.coordinateToPrice(y);
          isDrawing = false;
          if (time && Number.isFinite(price)) {
            lineEnd = { time, price };
          } else if (lastPreviewEnd) {
            lineEnd = { time: lastPreviewEnd.time, price: lastPreviewEnd.price };
          }
          if (!lineEnd) { lastPreviewEnd = null; return; }
          redrawAllDrawings();
          var tipX, tipY;
          var endX = safeTimeToCoord(lineEnd.time);
          var endY = candleSeries.priceToCoordinate(lineEnd.price);
          tipX = (endX !== null) ? endX : (lastPreviewEnd ? lastPreviewEnd.px : drawLayer.width / drawDpr / 2);
          tipY = (endY !== null) ? endY : (lastPreviewEnd ? lastPreviewEnd.py : drawLayer.height / drawDpr / 2);
          lastPreviewEnd = null;
          showDrawConfirm(tipX, tipY, activeColor, activeTool);
        });
        drawLayer.addEventListener('pointercancel', (e) => {
          if (editingDrawingIdx >= 0 && editingEndpoint) {
            var eidx = editingDrawingIdx;
            var didMove = editingDidMove;
            editingDrawingIdx = -1;
            editingEndpoint = null;
            editingDidMove = false;
            selectedDrawingIdx = eidx;
            redrawAllDrawings();
            if (didMove) notifyDrawingsChanged();
            return;
          }
          if (!isDrawing || !lineStart) return;
          isDrawing = false;
          if (lastPreviewEnd) {
            lineEnd = { time: lastPreviewEnd.time, price: lastPreviewEnd.price };
          }
          if (!lineEnd) { lastPreviewEnd = null; return; }
          redrawAllDrawings();
          var tipX = lastPreviewEnd ? lastPreviewEnd.px : drawLayer.width / drawDpr / 2;
          var tipY = lastPreviewEnd ? lastPreviewEnd.py : drawLayer.height / drawDpr / 2;
          lastPreviewEnd = null;
          showDrawConfirm(tipX, tipY, activeColor, activeTool);
        });
      }

      applyDefaultMainViewport();
      chart.timeScale().applyOptions({
        barSpacing: 8,
        minBarSpacing: 1,
        // Must match the rightOffset set at chart creation — otherwise
        // the post-boot applyOptions would snap the viewport back
        // from 14 to the smaller value right after the first settle
        // pass, which reads as a tiny one-frame horizontal jump
        // right after the loader lifts.
        rightOffset: VIEW_RIGHT_PAD,
        fixLeftEdge: data.length >= DEFAULT_VIEW_BARS,
        lockVisibleTimeRangeOnResize: true,
      });

      const requestThrottleMs = 1500;
      let lastRequestTs = 0;
      // Separate RAF flags so trim coalescing can't drop H/L label updates
      // (and vice versa) mid-pan.
      let rangeUpdatePending = false;
      let trimPending = false;
      let scaleSyncPending = false;

      function scheduleScaleSync() {
        if (scaleSyncPending) return;
        scaleSyncPending = true;
        requestAnimationFrame(() => {
          scaleSyncPending = false;
          syncPriceScaleWidths();
          const range = getNumericRange(mainChart.timeScale().getVisibleRange());
          if (range) {
            syncSubRanges(range);
          }
        });
      }

      function getMinTime() {
        return data.length ? data[0].time : null;
      }

      function findFirstIndex(time) {
        let lo = 0;
        let hi = data.length - 1;
        let ans = data.length;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (data[mid].time >= time) {
            ans = mid;
            hi = mid - 1;
          } else {
            lo = mid + 1;
          }
        }
        return ans;
      }

      function findLastIndex(time) {
        let lo = 0;
        let hi = data.length - 1;
        let ans = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (data[mid].time <= time) {
            ans = mid;
            lo = mid + 1;
          } else {
            hi = mid - 1;
          }
        }
        return ans;
      }

      function findIndex(time) {
        let lo = 0;
        let hi = data.length - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const t = data[mid].time;
          if (t === time) return mid;
          if (t < time) lo = mid + 1;
          else hi = mid - 1;
        }
        return Math.max(0, Math.min(data.length - 1, lo));
      }

      function trimDataAroundVisible() {
        if (data.length <= TRIM_THRESHOLD) return;
        // Don't trim if history is exhausted and we have limited data
        // This prevents oscillation when there's not much history
        if (window.__historyExhausted && data.length < MAX_POINTS * 1.5) return;
        const range = getNumericRange(chart.timeScale().getVisibleRange());
        if (!range) return;
        const midTime = Math.floor((range.from + range.to) / 2);
        const midIndex = findIndex(midTime);
        const half = Math.floor(MAX_POINTS / 2);
        let start = Math.max(0, midIndex - half);
        let end = Math.min(data.length, start + MAX_POINTS);
        start = Math.max(0, end - MAX_POINTS);
        data = data.slice(start, end);
        candleSeries.setData(data);
        syncLineSeries();
      }

      function updateTradeMarkers() {
        const root = document.getElementById('trade-markers-root');
        if (!root) return;
        root.innerHTML = '';
        // B/S trade-marker badges are disabled on purpose. The full
        // renderer below is kept intact so re-enabling is a one-line
        // change (just delete this early return). The settings toggle
        // and the React-side marker feed are also left in place so
        // state keeps flowing — this just short-circuits the DOM paint.
        return;
        // eslint-disable-next-line no-unreachable
        if (!showTradeMarkers || !tradeMarkersList.length) return;
        const range = chart.timeScale().getVisibleRange();
        const safeRange = getNumericRange(range);
        if (!safeRange) return;
        const from = safeRange.from;
        const to = safeRange.to;
        const activeSeries = currentChartMode === 'line' ? smoothLineSeries : candleSeries;
        const stackKeyCount = {};
        const frag = document.createDocumentFragment();
        const h = mainWrap ? mainWrap.clientHeight : CHART_HEIGHT;
        tradeMarkersList.forEach(function(m) {
          if (!m || m.t === undefined || m.t === null) return;
          var tt = Number(m.t);
          if (!Number.isFinite(tt)) return;
          if (tt < from || tt > to) return;
          var x = chart.timeScale().timeToCoordinate(tt);
          if (x === null) return;
          // Fills occur at arbitrary times inside a bar — use last bar with open <= fill time (not exact bar key match).
          var bi = findLastIndex(tt);
          if (bi < 0) return;
          var cnd = data[bi];
          if (!cnd) return;
          // OKX-style: pin B under the bar low, S above the bar high (same coordinate space as candles).
          var anchorPx = m.buy ? cnd.low : cnd.high;
          var py = activeSeries.priceToCoordinate(anchorPx);
          if (py === null) return;
          var y = m.buy ? py + 6 : py - 6 - 13;
          y = Math.max(2, Math.min(h - 15, y));
          var sk = String(Math.round(x)) + '_' + String(Math.round(y));
          var n = stackKeyCount[sk] || 0;
          stackKeyCount[sk] = n + 1;
          y += m.buy ? n * 14 : -n * 14;
          y = Math.max(2, Math.min(h - 15, y));
          var el = document.createElement('span');
          el.className = 'trade-marker ' + (m.buy ? 'trade-marker-buy' : 'trade-marker-sell');
          el.textContent = m.buy ? 'B' : 'S';
          el.style.left = x + 'px';
          el.style.top = y + 'px';
          frag.appendChild(el);
        });
        root.appendChild(frag);
      }

      function updateRangeInfo(range) {
        try {
        const highLabel = document.getElementById('high-label');
        const lowLabel = document.getElementById('low-label');
        const safeRange = getNumericRange(range);
        if (!safeRange || !data.length) {
          if (highLabel) highLabel.style.opacity = 0;
          if (lowLabel) lowLabel.style.opacity = 0;
          return;
        }
        if (!showHighLow) {
          if (highLabel) highLabel.style.opacity = 0;
          if (lowLabel) lowLabel.style.opacity = 0;
          return;
        }
        const containerWidth = mainWrap ? mainWrap.clientWidth : (mainChartEl ? mainChartEl.clientWidth : 0);
        const chartHeight = mainWrap ? mainWrap.clientHeight : CHART_HEIGHT;
        const from = Math.floor(safeRange.from);
        const to = Math.ceil(safeRange.to);
        let startIdx = findFirstIndex(from);
        let endIdx = findLastIndex(to);
        
        // Clamp indices to valid data bounds
        // findFirstIndex can return data.length (when from is after all data)
        // findLastIndex can return -1 (when to is before all data)
        if (startIdx >= data.length) {
          // Visible range starts after all data
          if (highLabel) highLabel.style.opacity = 0;
          if (lowLabel) lowLabel.style.opacity = 0;
          return;
        }
        if (endIdx < 0) {
          // Visible range ends before all data
          if (highLabel) highLabel.style.opacity = 0;
          if (lowLabel) lowLabel.style.opacity = 0;
          return;
        }
        
        // Ensure valid bounds
        startIdx = Math.max(0, startIdx);
        endIdx = Math.min(data.length - 1, endIdx);
        
        if (startIdx > endIdx) {
          if (highLabel) highLabel.style.opacity = 0;
          if (lowLabel) lowLabel.style.opacity = 0;
          return;
        }
        
        // Calculate High/Low from VISIBLE candles only
        let high = -Infinity;
        let low = Infinity;
        let highTime = null;
        let lowTime = null;
        
        // Get the visible logical range (bar indices)
        const logicalRange = chart.timeScale().getVisibleLogicalRange();
        let visibleStart = 0;
        let visibleEnd = data.length - 1;
        
        if (logicalRange && logicalRange.from !== undefined && logicalRange.to !== undefined) {
          // Logical range gives bar indices (can be negative for whitespace before first bar)
          visibleStart = Math.max(0, Math.floor(logicalRange.from));
          visibleEnd = Math.min(data.length - 1, Math.ceil(logicalRange.to));
        }
        
        const useClose = currentChartMode === 'line';
        for (let i = visibleStart; i <= visibleEnd; i++) {
          const item = data[i];
          if (!item) continue;
          const itemHigh = useClose ? (typeof item.close === 'number' ? item.close : parseFloat(item.close))
            : (typeof item.high === 'number' ? item.high : parseFloat(item.high));
          const itemLow = useClose ? itemHigh
            : (typeof item.low === 'number' ? item.low : parseFloat(item.low));
          if (!isFinite(itemHigh) || !isFinite(itemLow)) continue;
          if (itemHigh > high) {
            high = itemHigh;
            highTime = item.time;
          }
          if (itemLow < low) {
            low = itemLow;
            lowTime = item.time;
          }
        }
        
        // Hide labels if no valid high/low found
        if (high === -Infinity || low === Infinity) {
          if (highLabel) highLabel.style.opacity = 0;
          if (lowLabel) lowLabel.style.opacity = 0;
          return;
        }
        
        const priceSeries = useClose ? smoothLineSeries : candleSeries;
        if (highLabel && highTime !== null) {
          const x = chart.timeScale().timeToCoordinate(highTime);
          const y = priceSeries.priceToCoordinate(high);
          if (x !== null && y !== null) {
            highLabel.textContent = fmtHL(high);
            highLabel.style.opacity = 1;
            const width = highLabel.offsetWidth || 0;
            const clampedX = containerWidth
              ? Math.max(width / 2 + 2, Math.min(containerWidth - width / 2 - 2, x))
              : x;
            const clampedY = Math.max(10, Math.min(chartHeight - 20, y - 14));
            highLabel.style.left = clampedX + 'px';
            highLabel.style.top = clampedY + 'px';
          } else {
            highLabel.style.opacity = 0;
          }
        }
        
        if (lowLabel && lowTime !== null) {
          const x = chart.timeScale().timeToCoordinate(lowTime);
          const y = priceSeries.priceToCoordinate(low);
          if (x !== null && y !== null) {
            lowLabel.textContent = fmtHL(low);
            lowLabel.style.opacity = 1;
            const width = lowLabel.offsetWidth || 0;
            const clampedX = containerWidth
              ? Math.max(width / 2 + 2, Math.min(containerWidth - width / 2 - 2, x))
              : x;
            const clampedY = Math.max(20, Math.min(chartHeight - 8, y + 16));
            lowLabel.style.left = clampedX + 'px';
            lowLabel.style.top = clampedY + 'px';
          } else {
            lowLabel.style.opacity = 0;
          }
        }
      } finally {
        updateTradeMarkers();
      }
      }

      // Helper: sync smooth line + area from candle data
      function syncLineSeries() {
        const ld = data.map(function(c) { return { time: c.time, value: c.close }; });
        smoothLineSeries.setData(ld);
        areaGlowSeries.setData(ld);
        if (currentChartMode === 'line') updatePulseDotPosition();
        renderIndicatorValues();
      }

      function updateLineSeriesPoint(candle) {
        const pt = { time: candle.time, value: candle.close };
        smoothLineSeries.update(pt);
        areaGlowSeries.update(pt);
        if (currentChartMode === 'line') updatePulseDotPosition();
        renderIndicatorValues();
      }

      window.__appendCandles = (incoming) => {
        if (!Array.isArray(incoming) || incoming.length === 0) return;
        incoming = incoming.map(cxCandle);
        if (incoming.length === 1) {
          const next = incoming[0];
          const last = data.length ? data[data.length - 1] : null;
          let applied = next;
          if (!last || next.time >= last.time) {
            if (!last || next.time > last.time) {
              data.push(next);
            } else {
              const merged = {
                ...last,
                ...next,
                open: last.open ?? next.open,
                high: Math.max(last.high ?? next.high, next.high ?? last.high),
                low: Math.min(last.low ?? next.low, next.low ?? last.low),
                close: next.close ?? last.close,
                volume: Math.max(last.volume ?? 0, next.volume ?? 0),
              };
              data[data.length - 1] = merged;
              applied = merged;
            }
            candleSeries.update(applied);
            updateLineSeriesPoint(applied);
            updateMainIndicators(payload.indicators || {});
            updateSubIndicators(payload.indicators || {});
            
            // Check if candle extends beyond visible price range and auto-scale if needed
            // priceToCoordinate returns null only when TIME is outside range, not PRICE
            // So we need to check if coordinates are outside the chart height bounds
            const chartHeight = mainWrap.clientHeight || CHART_HEIGHT;
            const highCoord = candleSeries.priceToCoordinate(applied.high);
            const lowCoord = candleSeries.priceToCoordinate(applied.low);
            const needsRescale = highCoord === null || lowCoord === null ||
              highCoord < 0 || lowCoord > chartHeight ||
              highCoord > chartHeight || lowCoord < 0;
            if (needsRescale) {
              chart.priceScale('right').applyOptions({ autoScale: true });
            }
            
            const currentRange = chart.timeScale().getVisibleRange();
            if (currentRange) updateRangeInfo(currentRange);
            scheduleScaleSync();
            return;
          }
          const idx = data.findIndex((d) => d.time === next.time);
          if (idx >= 0) {
            const prev = data[idx];
            const merged = {
              ...prev,
              ...next,
              open: prev.open ?? next.open,
              high: Math.max(prev.high ?? next.high, next.high ?? prev.high),
              low: Math.min(prev.low ?? next.low, next.low ?? prev.low),
              close: next.close ?? prev.close,
              volume: Math.max(prev.volume ?? 0, next.volume ?? 0),
            };
            data[idx] = merged;
            candleSeries.setData(data);
            syncLineSeries();
            updateMainIndicators(payload.indicators || {});
            updateSubIndicators(payload.indicators || {});
            
            // Check if merged candle extends beyond visible price range
            const chartHeight = mainWrap.clientHeight || CHART_HEIGHT;
            const highCoord = candleSeries.priceToCoordinate(merged.high);
            const lowCoord = candleSeries.priceToCoordinate(merged.low);
            if (
              highCoord === null ||
              lowCoord === null ||
              highCoord < 0 ||
              lowCoord > chartHeight ||
              highCoord > chartHeight ||
              lowCoord < 0
            ) {
              chart.priceScale('right').applyOptions({ autoScale: true });
            }
            
            const currentRange = chart.timeScale().getVisibleRange();
            if (currentRange) updateRangeInfo(currentRange);
            scheduleScaleSync();
            return;
          }
        }
        const map = new Map();
        data.forEach((d) => map.set(d.time, d));
        incoming.forEach((d) => map.set(d.time, d));
        data = Array.from(map.values()).sort((a, b) => a.time - b.time);
        candleSeries.setData(data);
        syncLineSeries();
        rebuildIndicators(payload.indicators || {});
        const currentRange = chart.timeScale().getVisibleRange();
        if (currentRange) updateRangeInfo(currentRange);
        trimDataAroundVisible();
        scheduleScaleSync();
      };

      // Sync candles from server - FULLY REPLACES completed candles to fix drift
      // Only merges the very latest candle (which is still being updated)
      window.__syncCandles = (incoming, replaceLatest) => {
        if (!Array.isArray(incoming) || incoming.length === 0) return;
        incoming = incoming.map(cxCandle);
        const sorted = [...incoming].sort((a, b) => a.time - b.time);
        const latestIncomingTime = sorted[sorted.length - 1]?.time;
        const replaceCurrent = !!replaceLatest;
        
        // Build a map of existing data
        const existingMap = new Map();
        data.forEach((d) => existingMap.set(d.time, d));
        
        // For each incoming candle:
        // - If it's the latest (current) candle, merge with existing
        //   unless replaceLatest (app resume) — that merge kept fake
        //   mid-price wicks from the background gap.
        // - Otherwise, FULLY REPLACE with server data
        sorted.forEach((incoming) => {
          if (incoming.time === latestIncomingTime && !replaceCurrent) {
            // Current candle - merge to preserve live updates
            const existing = existingMap.get(incoming.time);
            if (existing) {
              existingMap.set(incoming.time, {
                ...incoming,
                high: Math.max(existing.high ?? incoming.high, incoming.high),
                low: Math.min(existing.low ?? incoming.low, incoming.low),
                close: existing.close ?? incoming.close, // Keep live close
              });
            } else {
              existingMap.set(incoming.time, incoming);
            }
          } else {
            // Completed candle - FULLY REPLACE with server data (fixes drift)
            existingMap.set(incoming.time, incoming);
          }
        });
        
        data = Array.from(existingMap.values()).sort((a, b) => a.time - b.time);
        candleSeries.setData(data);
        syncLineSeries();
        updateMainIndicators(payload.indicators || {});
        updateSubIndicators(payload.indicators || {});
        const currentRange = chart.timeScale().getVisibleRange();
        if (currentRange) updateRangeInfo(currentRange);
        scheduleScaleSync();
      };

      var lastSettingsJson = JSON.stringify(payload.settings || {});
      window.__setChartSettings = (nextSettings) => {
        var merged = { ...(payload.settings || {}), ...(nextSettings || {}) };
        var mergedJson = JSON.stringify(merged);
        if (mergedJson === lastSettingsJson) return;
        lastSettingsJson = mergedJson;
        payload.settings = merged;
        showOrderLines = payload.settings?.showOrderLines !== false;
        showHighLow = payload.settings?.showHighLow !== false;
        showOhlcvHud = payload.settings?.showOhlcvHud !== false;
        if (!showOhlcvHud) hideHud();
        showTradeMarkers = payload.settings?.showTradeMarkers === true;
        useUtc = payload.settings?.useUtc === true;  // Default to local (false)
        drawingEnabled = payload.settings?.drawingEnabled === true;
        var shouldShowInd = payload.settings?.showIndValues === true;
        if (shouldShowInd !== indValuesOpen) {
          indValuesOpen = shouldShowInd;
          if (indToggleEl) {
            if (indValuesOpen) { indToggleEl.classList.add('open'); } else { indToggleEl.classList.remove('open'); }
          }
          if (indicatorValuesEl) {
            if (indValuesOpen) { indicatorValuesEl.classList.add('visible'); renderIndicatorValues(); } else { indicatorValuesEl.classList.remove('visible'); }
          }
        } else if (indicatorValuesEl && indValuesOpen) {
          renderIndicatorValues();
        }
        syncMainIndicatorLineGate();
        const newMode = payload.settings?.chartMode || 'candle';
        if (newMode !== currentChartMode) {
          applyChartMode(newMode);
          if (newMode === 'line') {
            syncLineSeries();
            requestAnimationFrame(function() { updatePulseDotPosition(); });
            setTimeout(function() { updatePulseDotPosition(); }, 80);
          } else {
            pulseDot.style.opacity = '0';
          }
          requestAnimationFrame(function() {
            var r = chart.timeScale().getVisibleRange();
            if (r) updateRangeInfo(r);
          });
          setTimeout(function() {
            var r = chart.timeScale().getVisibleRange();
            if (r) updateRangeInfo(r);
          }, 80);
        }
        if (!drawingEnabled) {
          isDrawing = false;
          lineStart = null;
          lineEnd = null;
          selectedDrawingIdx = -1;
          editingDrawingIdx = -1;
          editingEndpoint = null;
          hideDrawConfirm();
          if (drawStartDot) drawStartDot.style.opacity = 0;
          if (drawEndDot) drawEndDot.style.opacity = 0;
        }
        redrawAllDrawings();
        applyOrderLines();
        applyCrosshairStyle();
        chart.applyOptions({
          localization: { timeFormatter: formatTimeLabel },
          timeScale: { tickMarkFormatter: formatTick },
        });
        
        // Force update of high/low labels - handle limited data charts
        const highLabel = document.getElementById('high-label');
        const lowLabel = document.getElementById('low-label');
        
        if (!showHighLow) {
          // Immediately hide labels when disabled
          if (highLabel) highLabel.style.opacity = 0;
          if (lowLabel) lowLabel.style.opacity = 0;
        } else if (data.length > 0) {
          // Try to get visible range, or create one from all data
          let range = chart.timeScale().getVisibleRange();
          if (!range && data.length > 0) {
            // Create a range covering all data
            range = { from: data[0].time, to: data[data.length - 1].time };
          }
          if (range) {
            updateRangeInfo(range);
          }
        }
        if (!showTradeMarkers) {
          var tmr = document.getElementById('trade-markers-root');
          if (tmr) tmr.innerHTML = '';
        } else {
          updateTradeMarkers();
        }
      };

      window.__setDrawTool = (tool) => {
        activeTool = tool || null;
        isDrawing = false;
        lineStart = null;
        lineEnd = null;
        hideDrawConfirm();
        if (drawStartDot) drawStartDot.style.opacity = 0;
        if (drawEndDot) drawEndDot.style.opacity = 0;
        applyCrosshairStyle();
        redrawAllDrawings();
      };

      window.__clearDrawings = () => {
        lineStart = null;
        lineEnd = null;
        isDrawing = false;
        confirmedDrawings = [];
        selectedDrawingIdx = -1;
        editingDrawingIdx = -1;
        editingEndpoint = null;
        hideDrawConfirm();
        if (drawLayer) {
          const ctx = drawLayer.getContext('2d');
          if (ctx) ctx.clearRect(0, 0, drawLayer.width / drawDpr, drawLayer.height / drawDpr);
        }
        if (drawStartDot) drawStartDot.style.opacity = 0;
        if (drawEndDot) drawEndDot.style.opacity = 0;
        notifyDrawingsChanged();
      };

      window.__setDrawings = (arr) => {
        confirmedDrawings = arr || [];
        lineStart = null; lineEnd = null; isDrawing = false;
        selectedDrawingIdx = -1; editingDrawingIdx = -1; editingEndpoint = null;
        hideDrawConfirm();
        redrawAllDrawings();
        setTimeout(function() { redrawAllDrawings(); }, 200);
        setTimeout(function() { redrawAllDrawings(); }, 600);
      };

      function notifyDrawingsChanged() {
        if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'drawings-changed',
            drawings: confirmedDrawings.map(function(d) { return { start: d.start, end: d.end, tool: d.tool, color: d.color }; }),
          }));
        }
      }

      function requestMoreHistory() {
        // Don't request if history is exhausted
        if (window.__historyExhausted) return;
        const minTime = getMinTime();
        if (!minTime) return;
        const now = Date.now();
        if (now - lastRequestTs < requestThrottleMs) return;
        lastRequestTs = now;
        if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'requestMoreHistory', minTime }));
        }
      }

      function scheduleRangeUpdate() {
        if (rangeUpdatePending) return;
        rangeUpdatePending = true;
        requestAnimationFrame(() => {
          rangeUpdatePending = false;
          // Always read the live viewport inside the frame — a captured
          // range from the first pan event of a coalesce window is already
          // stale by the time we paint.
          const range = getNumericRange(mainChart.timeScale().getVisibleRange());
          if (range) {
            updateRangeInfo(range);
          } else if (data.length) {
            updateRangeInfo({ from: data[0].time, to: data[data.length - 1].time });
          }
        });
      }

      function scheduleTrim() {
        if (trimPending) return;
        trimPending = true;
        requestAnimationFrame(() => {
          trimPending = false;
          trimDataAroundVisible();
        });
      }

      function syncSubRanges(range) {
        const mainLogicalRange = getNumericLogicalRange(mainChart.timeScale().getVisibleLogicalRange());
        const safeRange = getNumericRange(range);
        if (!mainLogicalRange && !safeRange) return;
        isSyncingRange = true;
        muteSubToMainUntil = Date.now() + 120;
        Object.values(subCharts).forEach((s) => {
          if (mainLogicalRange) {
            const currentSubLogicalRange = getNumericLogicalRange(s.chart.timeScale().getVisibleLogicalRange());
            if (currentSubLogicalRange && isRangeNearlyEqual(currentSubLogicalRange, mainLogicalRange)) return;
            try {
              s.chart.timeScale().setVisibleLogicalRange(mainLogicalRange);
              return;
            } catch {}
          }
          if (safeRange) {
            const currentSubRange = getNumericRange(s.chart.timeScale().getVisibleRange());
            if (currentSubRange && isRangeNearlyEqual(currentSubRange, safeRange)) return;
            try {
              s.chart.timeScale().setVisibleRange(safeRange);
            } catch {}
          }
        });
        isSyncingRange = false;
      }

      window.__setViewport = (nextViewport) => {
        const nextLogicalRange = getNumericLogicalRange(nextViewport && nextViewport.logicalRange);
        const nextTimeRange = getNumericRange(nextViewport && nextViewport.timeRange);
        if (!nextLogicalRange && !nextTimeRange) return;
        isSyncingRange = true;
        try {
          if (nextLogicalRange) {
            mainChart.timeScale().setVisibleLogicalRange(nextLogicalRange);
          } else {
            mainChart.timeScale().setVisibleRange(nextTimeRange);
          }
        } catch {}
        isSyncingRange = false;
        ensureRightGap();
        const range = getNumericRange(mainChart.timeScale().getVisibleRange());
        if (range) {
          updateRangeInfo(range);
          syncSubRanges(range);
        }
        scheduleScaleSync();
        postViewportState(true);
      };

      let lastRangeFrom = null;
      let lastRangeTo = null;
      chart.timeScale().subscribeVisibleTimeRangeChange((range) => {
        const safeRange = getNumericRange(range);
        if (!safeRange) return;
        
        // Prevent excessive updates - only update if range changed meaningfully
        const rangeDelta = safeRange.to - safeRange.from;
        const minDelta = rangeDelta * 0.01; // 1% change threshold
        if (lastRangeFrom !== null && lastRangeTo !== null) {
          const fromDiff = Math.abs(safeRange.from - lastRangeFrom);
          const toDiff = Math.abs(safeRange.to - lastRangeTo);
          if (fromDiff < minDelta && toDiff < minDelta) {
            syncSubRanges(safeRange);
            scheduleScaleSync();
            postViewportState(false);
            updateTradeMarkers();
            // Still reposition H/L — small pans move candle pixels even when
            // the time-range delta is under the heavy-work threshold.
            scheduleRangeUpdate();
            return; // Skip heavy work if range barely changed
          }
        }
        lastRangeFrom = safeRange.from;
        lastRangeTo = safeRange.to;
        
        const minTime = getMinTime();
        if (minTime) {
          const buffer = (safeRange.to - safeRange.from) * 0.1;
          if (safeRange.from <= minTime + buffer) {
            requestMoreHistory();
          }
        }
        scheduleRangeUpdate();
        // Only trim if we have lots of data and history isn't exhausted
        if (!window.__historyExhausted || data.length > TRIM_THRESHOLD) {
          scheduleTrim();
        }
        syncSubRanges(safeRange);
        scheduleScaleSync();
        postViewportState(false);
        if (confirmedDrawings.length > 0) redrawAllDrawings();
      });

      function resizeChart() {
        applyLayout(currentSubCount);
        ensureRightGap();
        const range = getNumericRange(chart.timeScale().getVisibleRange());
        if (range) {
          syncSubRanges(range);
          updateRangeInfo(range);
        } else {
          updateTradeMarkers();
        }
        postViewportState(false);
        resizeDrawLayer();
        redrawAllDrawings();
      }

      window.__resetView = () => {
        applyDefaultMainViewport();
        chart.priceScale('right').applyOptions({ autoScale: true });
        const range = chart.timeScale().getVisibleRange();
        if (range) {
          updateRangeInfo(range);
          syncSubRanges(range);
        }
        postViewportState(true);
      };

      window.__zoomIn = () => {
        const logicalRange = getNumericLogicalRange(chart.timeScale().getVisibleLogicalRange());
        if (!logicalRange) return;
        const mid = (logicalRange.from + logicalRange.to) / 2;
        const halfSpan = (logicalRange.to - logicalRange.from) * 0.35;
        const next = { from: mid - halfSpan, to: mid + halfSpan };
        try { chart.timeScale().setVisibleLogicalRange(next); } catch {}
        const range = getNumericRange(chart.timeScale().getVisibleRange());
        if (range) { updateRangeInfo(range); syncSubRanges(range); }
        postViewportState(false);
      };

      window.__zoomOut = () => {
        const logicalRange = getNumericLogicalRange(chart.timeScale().getVisibleLogicalRange());
        if (!logicalRange) return;
        const mid = (logicalRange.from + logicalRange.to) / 2;
        const halfSpan = (logicalRange.to - logicalRange.from) * 0.75;
        // Ceiling on how far right a zoom-out can push "to". Kept a
        // hair above the default viewport's right-pad (14) so the
        // user can still see a touch more empty space when actively
        // zooming out, without it snapping back to < default.
        const maxTo = data.length - 1 + 16;
        const minFrom = data.length >= DEFAULT_VIEW_BARS
          ? 0
          : (data.length - 1 + VIEW_RIGHT_PAD - DEFAULT_VIEW_BARS);
        const next = { from: Math.max(minFrom, mid - halfSpan), to: Math.min(maxTo, mid + halfSpan) };
        try { chart.timeScale().setVisibleLogicalRange(next); } catch {}
        const range = getNumericRange(chart.timeScale().getVisibleRange());
        if (range) { updateRangeInfo(range); syncSubRanges(range); }
        postViewportState(false);
      };

        // Reusable settle routine. Polls price-scale width until it has
        // been stable for 2 consecutive frames, then posts chart-settled.
        // Used by both the initial boot path and by __reloadChart (interval
        // swaps in place without remounting the WebView).
        //
        // Uses a monotonic settleGen counter so a later call (e.g.
        // __reloadChart triggered right after boot when the expanded
        // WebView inherited a stale baked HTML) supersedes an in-flight
        // earlier settle. Without this, the boot's initial settle could
        // post chart-settled while the old-interval bars were still on
        // screen, briefly lifting the dim overlay over stale data before
        // the reload's setData landed.
        var settleGen = 0;
        function runChartSettle() {
          if (!window.ReactNativeWebView || !window.ReactNativeWebView.postMessage) return;
          var gen = ++settleGen;
          var settledPosted = false;
          function postChartSettled() {
            if (settledPosted) return;
            if (gen !== settleGen) return;
            settledPosted = true;
            try { if (mainWrap) mainWrap.style.transition = ''; } catch (e) {}
            try { if (subRoot) subRoot.style.transition = ''; } catch (e) {}
            try {
              window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'chart-settled' }));
            } catch (e) {}
          }
          requestAnimationFrame(function() {
            if (gen !== settleGen) return;
            try { scheduleScaleSync(); } catch (e) {}
            requestAnimationFrame(function() {
              if (gen !== settleGen) return;
              try { ensureRightGap(); } catch (e) {}
              var lastWidth = -1;
              var stableFrames = 0;
              var pollStart = Date.now();
              function pollWidth() {
                if (settledPosted) return;
                if (gen !== settleGen) return;
                var w = 0;
                try { w = getMainScaleWidth() || 0; } catch (e) { w = 0; }
                if (w > 0 && w === lastWidth) {
                  stableFrames += 1;
                } else {
                  stableFrames = 0;
                }
                lastWidth = w;
                var elapsed = Date.now() - pollStart;
                if (stableFrames >= 2 || elapsed >= 450) {
                  try { syncPriceScaleWidths(); } catch (e) {}
                  setTimeout(postChartSettled, 16);
                  return;
                }
                requestAnimationFrame(pollWidth);
              }
              requestAnimationFrame(pollWidth);
            });
          });
        }

        // In-place data reload. Called by RN when the user changes interval
        // so we can swap datasets without remounting the WebView — the full
        // native WebView boot + engine init + layout settle takes 200–400ms
        // per switch, which is what the user perceived as "shake". This
        // path keeps the WebView warm and only re-runs setData +
        // rebuildIndicators + applyDefaultMainViewport, which is a few
        // frames at most.
        window.__reloadChart = function(incoming) {
          if (!Array.isArray(incoming) || incoming.length === 0) return;
          try {
            var mapped = uniqueSortedCandles(incoming.map(cxCandle));
            if (!mapped.length) return;
            data = mapped;
            refreshTimeAlign();
            candleSeries.setData(data);
            syncLineSeries();
            // Mobile LWC pins the crosshair at the last touched position
            // AND keeps its internal touch-tracking state "armed" until
            // the user taps elsewhere. clearCrosshairPosition() removes
            // the visual but doesn't reset the gesture state machine, so
            // the next finger-drag (even a normal pan) will re-snap the
            // crosshair without requiring a fresh long-press. Combined
            // approach: (1) clear the visual on every chart, (2) bounce
            // handleScroll/handleScale to force LWC to rebuild its input
            // handlers, (3) dispatch synthetic touchcancel/pointercancel
            // events on the chart elements so any in-flight gesture is
            // hard-aborted at the DOM layer too.
            function resetChartGestureState(c, el) {
              try { c.clearCrosshairPosition(); } catch (e) {}
              try {
                c.applyOptions({ handleScroll: false, handleScale: false });
                c.applyOptions({ handleScroll: true, handleScale: true });
              } catch (e) {}
              if (el) {
                try {
                  var tc = document.createEvent('Event');
                  tc.initEvent('touchcancel', true, true);
                  el.dispatchEvent(tc);
                } catch (e) {}
                try {
                  var pc = document.createEvent('Event');
                  pc.initEvent('pointercancel', true, true);
                  el.dispatchEvent(pc);
                } catch (e) {}
              }
              // Hide the OHLCV HUD too — clearCrosshairPosition() doesn't
              // fire subscribeCrosshairMove on all LWC versions, so the
              // HUD could linger with stale values across an interval swap.
              try { if (typeof hideHud === 'function') hideHud(); } catch (e) {}
              try { if (typeof hideFutureTimeLabel === 'function') hideFutureTimeLabel(); } catch (e) {}
            }
            resetChartGestureState(chart, mainChartEl);
            try {
              Object.values(subCharts).forEach(function(s) {
                resetChartGestureState(s.chart, s.el);
              });
            } catch (e) {}
            if (crosshairDot) { crosshairDot.style.opacity = 0; }
            // rebuildIndicators() captures the current visible logical range
            // at entry and restores it in a deferred setTimeout(0) when
            // hasInitializedViewport is true. On an interval change the
            // previous range's indices (e.g. 950-995 from a 1000-bar 1m
            // series) are out of bounds for the new dataset (e.g. ~100 5m
            // bars), which collapses the view to 2 visible candles. We
            // reset the flag so rebuildIndicators takes the "fresh boot"
            // branch and calls applyDefaultMainViewport() itself — matching
            // the behavior the user expects after an interval switch.
            hasInitializedViewport = false;
            rebuildIndicators(payload.indicators || {});
            applyDefaultMainViewport();
            // Belt-and-suspenders: rebuildIndicators' internal setTimeout(0)
            // may still apply layout and ranges asynchronously, so re-apply
            // the default viewport on the next tick so we win the last write.
            setTimeout(function() {
              try { applyDefaultMainViewport(); } catch (e) {}
              try { ensureRightGap(); } catch (e) {}
              var postRange = chart.timeScale().getVisibleRange();
              if (postRange) { updateRangeInfo(postRange); syncSubRanges(postRange); }
            }, 0);
            // Force an autoScale pass on the price axis so the Y-range
            // adapts to the new dataset's magnitude (critical for big
            // interval leaps like 1w -> 5m where price range collapses).
            try { chart.priceScale('right').applyOptions({ autoScale: true }); } catch (e) {}
            var range = chart.timeScale().getVisibleRange();
            if (range) { updateRangeInfo(range); syncSubRanges(range); }
            postViewportState(true);
            runChartSettle();
          } catch (e) {
            if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
              window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'chart-error', msg: 'reload failed', detail: String(e && e.message) }));
            }
          }
        };

        window.addEventListener('resize', resizeChart);
        resizeChart();
        setTimeout(() => {
          ensureRightGap();
          const range = chart.timeScale().getVisibleRange();
          if (range) {
            syncSubRanges(range);
          }
          updateRangeInfo(chart.timeScale().getVisibleRange());
          postViewportState(true);
          if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
            window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'chart-ready' }));
            runChartSettle();
            setTimeout(function() {
              window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'request-drawings' }));
            }, 300);
            setTimeout(function() {
              window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'request-drawings' }));
            }, 800);
          }
        }, 0);
      };

      window.onerror = function(message, source, lineno, colno, error) {
        if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'chart-error', msg: String(message), detail: String(error?.message || ''), source, lineno, colno }));
        }
      };

      (function waitForLwc() {
        if (window.LightweightCharts) {
          window.__startChart();
          return;
        }
        window.__lwcTries = (window.__lwcTries || 0) + 1;
        if (window.__lwcTries > 60) {
          if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
            window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'chart-error', msg: 'LWC load timeout' }));
          }
          return;
        }
        setTimeout(waitForLwc, 100);
      })();

      // Touch direction detection: horizontal swipe = chart pan, hold = crosshair
      (function() {
        var sx = 0, sy = 0, decided = false, active = false;
        var holdTimer = null;
        var THRESH = 8;
        var HOLD_MS = 200;
        function sigOn() {
          if (active) return;
          active = true;
          if (window.ReactNativeWebView) {
            window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'chart-interacting', active: true }));
          }
        }
        function sigOff() {
          if (!active) return;
          active = false;
          if (window.ReactNativeWebView) {
            window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'chart-interacting', active: false }));
          }
        }
        document.addEventListener('touchstart', function(e) {
          var t = e.touches[0];
          sx = t.clientX; sy = t.clientY;
          decided = false; active = false;
          if (holdTimer) clearTimeout(holdTimer);
          holdTimer = setTimeout(function() {
            holdTimer = null;
            if (!decided) { decided = true; sigOn(); }
          }, HOLD_MS);
        }, { passive: true });
        document.addEventListener('touchmove', function(e) {
          if (decided) return;
          var t = e.touches[0];
          var dx = Math.abs(t.clientX - sx), dy = Math.abs(t.clientY - sy);
          if (dx > THRESH || dy > THRESH) {
            decided = true;
            if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
            if (dx > dy) sigOn();
          }
        }, { passive: true });
        document.addEventListener('touchend', function() {
          if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
          sigOff(); decided = false;
        }, { passive: true });
        document.addEventListener('touchcancel', function() {
          if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
          sigOff(); decided = false;
        }, { passive: true });
      })();
    </script>
  </body>
</html>`;
  }, [initialCandles, lwcBase64, cRate, cConverted, cMeta.symbol, cMeta.decimals]);

  // Key only changes when we genuinely need to tear down and remount the
  // WebView (coin change, error retry). Interval switches are handled by
  // __reloadChart over the already-mounted WebView — see the reload path
  // in the candleData effect below.
  const chartKey = useMemo(() => `${chartId ?? 'default'}-${decodedCoin}`, [chartId, decodedCoin]);

  // `mountedChartHtml` is the source we actually hand to <WebView>. It's
  // captured once per chartKey (on the first non-null `lightweightChartHtml`
  // for that key) and then frozen. Subsequent recomputes of
  // `lightweightChartHtml` (e.g. when an interval switch updates
  // `initialCandles`) DON'T flow into the WebView's source prop, so the
  // native WebView never re-navigates / re-parses / re-inits the chart
  // engine on an interval change — we push the new data via
  // window.__reloadChart instead.
  const [mountedChartHtml, setMountedChartHtml] = useState<string | null>(null);
  const mountedChartHtmlKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (mountedChartHtmlKeyRef.current !== chartKey) {
      mountedChartHtmlKeyRef.current = chartKey;
      setMountedChartHtml(null);
    }
  }, [chartKey]);

  useEffect(() => {
    if (!lightweightChartHtml) return;
    if (mountedChartHtmlKeyRef.current !== chartKey) return;
    setMountedChartHtml((cur) => {
      if (cur) return cur;
      // Remember which initialCandles reference was baked into the HTML
      // we're about to freeze, so freshly-mounted WebViews (e.g. landscape
      // expand) can detect staleness at chart-ready time.
      bakedInitialCandlesRef.current = initialCandles;
      return lightweightChartHtml;
    });
  }, [chartKey, initialCandles, lightweightChartHtml]);

  useEffect(() => {
    setIsWebViewReady(false);
    setIsChartVisible(false);
    // Symbol switch = full WebView remount = fresh chart boot. Reset
    // both "ever ready" / "ever settled" flags so the OPAQUE loading
    // overlay covers the entire new boot window instead of the dimmer
    // 55% dim overlay (which lets the engine's brief native fit-all-
    // bars paint bleed through before applyDefaultMainViewport snaps
    // it to the 45-bar default — same root cause as the cold-boot
    // case, just for symbol changes).
    setHasEverBeenSettled(false);
    hasEverBeenReadyRef.current = false;
    if (chartVisibleTimerRef.current) { clearTimeout(chartVisibleTimerRef.current); chartVisibleTimerRef.current = null; }
    chartErrorCountRef.current = 0;
    lastViewportRef.current = null;
    if (webViewReadyTimeoutRef.current) {
      clearTimeout(webViewReadyTimeoutRef.current);
      webViewReadyTimeoutRef.current = null;
    }
    // Coin/key change voids any pending in-place reload — cancel its watchdog
    // so a stale fire doesn't bump the freshly-mounted WebView's retry key.
    reloadInFlightRef.current = false;
    if (reloadWatchdogRef.current) {
      clearTimeout(reloadWatchdogRef.current);
      reloadWatchdogRef.current = null;
    }
    // Also cancel the tiered settle watchdog — a pending soft/hard recovery
    // targeted at the previous chartKey must not fire against the new one.
    clearSettleWatchdog();
    hardRemountCountRef.current = 0;
    if (dataStuckWatchdogRef.current) {
      clearTimeout(dataStuckWatchdogRef.current);
      dataStuckWatchdogRef.current = null;
    }
  }, [chartKey, clearSettleWatchdog]);

  useEffect(() => {
    return () => {
      if (reloadWatchdogRef.current) {
        clearTimeout(reloadWatchdogRef.current);
        reloadWatchdogRef.current = null;
      }
      if (settleWatchdogRef.current) {
        clearTimeout(settleWatchdogRef.current);
        settleWatchdogRef.current = null;
      }
      if (dataStuckWatchdogRef.current) {
        clearTimeout(dataStuckWatchdogRef.current);
        dataStuckWatchdogRef.current = null;
      }
    };
  }, []);

  // Render candlestick chart with proper bounds
  const renderChart = () => {
    if (!candleData?.candles || candleData.candles.length === 0) {
      return (
        <View style={[styles.chartPlaceholder, noHorizontalMargin && styles.chartPlaceholderNoMargin]}>
          <Text style={styles.chartPlaceholderText}>No chart data available</Text>
        </View>
      );
    }

    const candles = candleData.candles;
    const maxVisible = Math.max(10, Math.min(candles.length, visibleCount));
    const visible = candles.slice(-maxVisible);
    const allPrices = visible.flatMap(c => [parseFloat(c.h), parseFloat(c.l)]);
    const extraPrices: number[] = [];
    if (Number.isFinite(entryPxNum ?? NaN)) extraPrices.push(entryPxNum as number);
    limitOrdersForCoin.forEach((o: any) => {
      const px = parseFloat(String(o?.limitPx ?? ''));
      if (Number.isFinite(px)) extraPrices.push(px);
    });
    const minPrice = Math.min(...allPrices, ...(extraPrices.length ? extraPrices : [Number.POSITIVE_INFINITY]));
    const maxPrice = Math.max(...allPrices, ...(extraPrices.length ? extraPrices : [Number.NEGATIVE_INFINITY]));
    const priceRange = maxPrice - minPrice || 1;
    
    // Add padding to price range
    const paddedMin = minPrice - (priceRange * 0.05);
    const paddedMax = maxPrice + (priceRange * 0.05);
    const paddedRange = paddedMax - paddedMin;
    
    const chartAreaWidth = chartWidth || (SCREEN_WIDTH - (CHART_PADDING * 2) - 70);
    const barWidth = Math.max(3, (chartAreaWidth / visible.length) - 2);

    const priceToY = (price: number) => {
      if (!Number.isFinite(price)) return 0;
      return Math.max(0, Math.min(CHART_HEIGHT, ((paddedMax - price) / paddedRange) * CHART_HEIGHT));
    };

    const latestClose = parseFloat(visible[visible.length - 1]?.c ?? 'NaN');
    const liveY = priceToY(latestClose);

    const pnlColor = entryLineColor;

    const selectedIdx = scrubIndex ?? (visible.length - 1);
    const selectedCandle = visible[Math.max(0, Math.min(visible.length - 1, selectedIdx))];
    const legendPrice = selectedCandle ? parseFloat(selectedCandle.c) : NaN;
    const legendTime = (selectedCandle as any)?.t ?? (selectedCandle as any)?.time ?? null;
    const fmtPrice = (n: number) => {
      if (!Number.isFinite(n)) return '--';
      const a = Math.abs(n);
      if (a >= 10000) return n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
      if (a >= 100) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      if (a >= 1) return n.toFixed(3);
      if (a >= 0.1) return n.toFixed(4);
      if (a >= 0.01) return n.toFixed(5);
      if (a >= 0.001) return n.toFixed(6);
      return n.toFixed(8);
    };

    return (
      <View style={styles.chartWrapper}>
        <View style={styles.chartContainer}>
          {/* Price labels */}
          <View style={styles.priceLabels}>
            <Text style={styles.priceLabel}>${paddedMax.toFixed(2)}</Text>
            <Text style={styles.priceLabel}>${((paddedMax + paddedMin) / 2).toFixed(2)}</Text>
            <Text style={styles.priceLabel}>${paddedMin.toFixed(2)}</Text>
          </View>
          
          {/* Chart area */}
          <View
            style={styles.chartArea}
            onLayout={(e) => setChartWidth(e.nativeEvent.layout.width)}
            {...PanResponder.create({
              onStartShouldSetPanResponder: () => true,
              onPanResponderGrant: (evt) => {
                setInteracting(true);
                if (scrubTimerRef.current) clearTimeout(scrubTimerRef.current);
                const x = evt.nativeEvent.locationX;
                scrubTimerRef.current = setTimeout(() => {
                  setIsScrubbing(true);
                  isScrubbingRef.current = true;
                  setScrubX(x);
                  const idx = Math.round((x / Math.max(1, chartAreaWidth)) * (visible.length - 1));
                  setScrubIndex(idx);
                }, 150);
              },
              onPanResponderMove: (evt) => {
                if (!isScrubbingRef.current) return;
                const x = Math.max(0, Math.min(chartAreaWidth, evt.nativeEvent.locationX));
                setScrubX(x);
                const idx = Math.round((x / Math.max(1, chartAreaWidth)) * (visible.length - 1));
                if (lastHapticIndexRef.current !== idx) {
                  lastHapticIndexRef.current = idx;
                  Haptics.selectionAsync();
                }
                setScrubIndex(idx);
              },
              onPanResponderRelease: () => {
                if (scrubTimerRef.current) clearTimeout(scrubTimerRef.current);
                setIsScrubbing(false);
                isScrubbingRef.current = false;
                setScrubIndex(null);
                setInteracting(false);
              },
              onPanResponderTerminate: () => {
                if (scrubTimerRef.current) clearTimeout(scrubTimerRef.current);
                setIsScrubbing(false);
                isScrubbingRef.current = false;
                setScrubIndex(null);
                setInteracting(false);
              },
            }).panHandlers}
          >
            {/* Grid lines */}
            <View style={[styles.gridLine, { top: 0 }]} />
            <View style={[styles.gridLine, { top: CHART_HEIGHT / 2 }]} />
            <View style={[styles.gridLine, { top: CHART_HEIGHT - 1 }]} />
            
            {/* Candles */}
            <View style={styles.barsContainer}>
              {visible.map((candle, index) => {
                const open = parseFloat(candle.o);
                const close = parseFloat(candle.c);
                const high = parseFloat(candle.h);
                const low = parseFloat(candle.l);
                
                const isGreen = close >= open;
                const barColor = isGreen ? colors.status.success : colors.status.error;
                
                // Calculate positions with bounds checking
                const wickTop = Math.max(0, ((paddedMax - high) / paddedRange) * CHART_HEIGHT);
                const wickBottom = Math.min(CHART_HEIGHT, ((paddedMax - low) / paddedRange) * CHART_HEIGHT);
                const bodyTop = Math.max(0, ((paddedMax - Math.max(open, close)) / paddedRange) * CHART_HEIGHT);
                const bodyBottom = Math.min(CHART_HEIGHT, ((paddedMax - Math.min(open, close)) / paddedRange) * CHART_HEIGHT);
                const bodyHeight = Math.max(2, bodyBottom - bodyTop);
                
                return (
                  <View key={index} style={[styles.candleWrapper, { width: barWidth + 2 }]}>
                    {/* Wick */}
                    <View
                      style={[
                        styles.wick,
                        {
                          backgroundColor: barColor,
                          top: wickTop,
                          height: Math.max(1, wickBottom - wickTop),
                        },
                      ]}
                    />
                    {/* Body */}
                    <View
                      style={[
                        styles.candleBody,
                        {
                          backgroundColor: barColor,
                          top: bodyTop,
                          height: bodyHeight,
                          width: barWidth,
                        },
                      ]}
                    />
                  </View>
                );
              })}
            </View>

            {/* Entry line */}
            {chartSettings.showOrderLines && Number.isFinite(entryPxNum ?? NaN) && (
              <View
                style={[
                  styles.entryLine,
                  {
                    top: priceToY(entryPxNum as number),
                    backgroundColor: pnlColor,
                    shadowColor: pnlColor,
                  },
                ]}
              />
            )}

            {/* Limit order lines */}
            {chartSettings.showOrderLines
              ? limitOrdersForCoin.map((o: any, idx: number) => {
                  const px = parseFloat(String(o?.limitPx ?? ''));
                  if (!Number.isFinite(px)) return null;
                  return (
                    <View key={`limit-${idx}`} style={[styles.limitLine, { top: priceToY(px) }]} />
                  );
                })
              : null}

            {/* Scrub line */}
            {isScrubbing ? <View style={[styles.scrubLine, { left: scrubX }]} /> : null}

            {/* Live price indicator */}
            {Number.isFinite(latestClose) && (
              <View style={[styles.livePricePill, { top: liveY - 12 }]}>
                <Text style={styles.livePriceText}>${latestClose.toFixed(2)}</Text>
              </View>
            )}
          </View>
        </View>

        {/* Legend */}
        {isScrubbing && selectedCandle ? (
          <View style={styles.legendPill}>
            <Text style={styles.legendText}>
              {fmtPrice(legendPrice)} · {legendTime ? new Date(legendTime).toLocaleString() : '--'}
            </Text>
          </View>
        ) : null}
      </View>
    );
  };

  const renderLightweightChart = (mode: 'inline' | 'expanded', isExpanded = false) => {
    const totalHeight = INLINE_CHART_TOTAL_HEIGHT;
    const chartActionsBottom = isExpanded ? Math.max(32, insets.bottom + 24) : 14;
    const expandedPaddingStyle = isExpanded
      ? {
          paddingTop: Math.max(8, insets.top + 4),
          paddingBottom: Math.max(8, insets.bottom + 8),
          paddingLeft: Math.max(8, insets.left + 4),
          paddingRight: Math.max(8, insets.right + 4),
        }
      : null;
    if (!lightweightChartHtml) {
      if (candlesLoading) {
        return (
          <View
            style={[
              styles.chartPlaceholder,
              isExpanded ? styles.chartPlaceholderExpanded : { height: totalHeight + 24 },
              !isExpanded && noHorizontalMargin && styles.chartPlaceholderNoMargin,
            ]}
          >
            <LoadingIndicator size="small" />
          </View>
        );
      }
      return (
        <View
          style={[
            styles.chartPlaceholder,
            isExpanded ? styles.chartPlaceholderExpanded : { height: totalHeight + 24 },
            !isExpanded && noHorizontalMargin && styles.chartPlaceholderNoMargin,
          ]}
        />
      );
    }
    return (
      <View
        style={[
          styles.chartWrapper,
          !isExpanded && noHorizontalMargin && styles.chartWrapperNoMargin,
          isExpanded && styles.chartWrapperExpanded,
          expandedPaddingStyle,
        ]}
        onLayout={(e) => {
          const w = e.nativeEvent.layout.width;
          if (w && Math.abs(w - containerWidth) > 0.5) {
            setContainerWidth(w);
          }
        }}
      >
        <View
          style={[
            styles.lightweightContainer,
            isExpanded ? styles.lightweightContainerExpanded : { height: totalHeight, width: '100%' },
          ]}
        >
          {mountedChartHtml && containerWidth > 0 ? (
            <WebView
              ref={mode === 'expanded' ? expandedWebViewRef : inlineWebViewRef}
              key={`${chartKey}-${isExpanded ? 'expanded' : 'inline'}-${Math.round(containerWidth)}-${webViewRetryKey}`}
              originWhitelist={['*']}
              source={{ html: mountedChartHtml }}
              style={[styles.lightweightWebview, !isChartVisible && !hasEverBeenReadyRef.current && { opacity: 0 }]}
              scrollEnabled={false}
              javaScriptEnabled
              domStorageEnabled
              androidLayerType="hardware"
              renderToHardwareTextureAndroid
              onLoad={() => {
                if (activeWebViewModeRef.current !== mode) return;
                if (webViewReadyTimeoutRef.current) {
                  clearTimeout(webViewReadyTimeoutRef.current);
                  webViewReadyTimeoutRef.current = null;
                }
              }}
              onLoadEnd={() => {
                if (activeWebViewModeRef.current !== mode) return;
                if (webViewReadyTimeoutRef.current) {
                  clearTimeout(webViewReadyTimeoutRef.current);
                  webViewReadyTimeoutRef.current = null;
                }
              }}
              onError={(syntheticEvent) => {
                if (activeWebViewModeRef.current !== mode) return;
                const { nativeEvent } = syntheticEvent;
                // Limit retries on native WebView errors
                chartErrorCountRef.current++;
                if (chartErrorCountRef.current > 3) {
                  console.warn('WebView error (max retries reached): ', nativeEvent);
                  return;
                }
                console.warn('WebView error: ', nativeEvent);
                setIsWebViewReady(false);
                setIsChartVisible(false);
                if (chartVisibleTimerRef.current) { clearTimeout(chartVisibleTimerRef.current); chartVisibleTimerRef.current = null; }
                clearSettleWatchdog();
                setWebViewRetryKey((k) => k + 1);
              }}
              onMessage={(event) => {
                try {
                  const msg = JSON.parse(event.nativeEvent.data);
                  const isActiveMode = activeWebViewModeRef.current === mode;
                  if (msg?.type === 'chart-ready') {
                    if (isActiveMode) {
                      setIsWebViewReady(true);
                      hasEverBeenReadyRef.current = true;
                      setWebViewReadyNonce((n) => n + 1);
                      setChartError(null);
                    }
                    // If a fresh WebView mounted (expanded mode on
                    // landscape expand, containerWidth re-key, or error
                    // retry) AFTER the user has switched intervals, the
                    // frozen mountedChartHtml it booted with contains the
                    // OLD interval's candles. `initialCandles` now holds
                    // the current interval's mapped data — push it via
                    // __reloadChart so the new WebView catches up.
                    //
                    // Without this the expanded view would render the old
                    // (baked) interval's bars, then the live-price effect
                    // would append a new-interval bar into the middle of
                    // that chart — the "large candle out of nowhere".
                    const currentCandles = initialCandles;
                    if (
                      currentCandles &&
                      (currentCandles as any[]).length > 0 &&
                      currentCandles !== bakedInitialCandlesRef.current
                    ) {
                      const reloadPayload = JSON.stringify(currentCandles);
                      const activeRef = mode === 'expanded' ? expandedWebViewRef.current : inlineWebViewRef.current;
                      if (activeRef) {
                        activeRef.injectJavaScript(
                          `(function(){try{window.__reloadChart&&window.__reloadChart(${reloadPayload});}catch(e){}return true;})();`,
                        );
                      }
                    }
                    // Single runtime-state injection right after chart-ready.
                    // The 140ms / 220ms repeats we used to schedule here would
                    // land *after* chart-settled on warmed-up WebViews, which
                    // caused __setOrderLines to rebuild price lines right
                    // when the overlay had just lifted — visible as a tiny
                    // horizontal shake of the candles.
                    setTimeout(() => injectWebViewRuntimeState(), 0);
                    setTimeout(() => applyStoredViewportToActive(), 20);
                    // Tiered settle watchdog (cold-boot phase). Replaces the
                    // old 900ms "lift-overlay-anyway" fallback, which used to
                    // reveal an empty dark WebView body if settle never came
                    // (the "black chart" edge case). Now: wait ~3.5s, attempt
                    // soft __reloadChart recovery, then a full remount, then
                    // surface the error overlay. The opaque loader stays up
                    // the whole time so the user never sees a blank chart.
                    if (chartVisibleTimerRef.current) {
                      clearTimeout(chartVisibleTimerRef.current);
                      chartVisibleTimerRef.current = null;
                    }
                    if (isActiveMode) armSettleWatchdog('cold-boot');
                    if (mode === 'expanded') {
                      const ref = expandedWebViewRef.current;
                      if (ref) {
                        ref.injectJavaScript(
                          `(function(){try{window.__setExpandedMode&&window.__setExpandedMode(true);}catch(e){}return true;})();`,
                        );
                      }
                      const injectSaved = () => {
                        const d = savedDrawingsRef.current;
                        const ref = expandedWebViewRef.current;
                        if (ref && d && d.length > 0) {
                          ref.injectJavaScript(`(function(){try{window.__setDrawings&&window.__setDrawings(${JSON.stringify(d)});}catch(e){}return true;})();`);
                        }
                      };
                      setTimeout(injectSaved, 350);
                      setTimeout(injectSaved, 800);
                      setTimeout(injectSaved, 1500);
                    }
                    return;
                  }
                  if (msg?.type === 'chart-settled') {
                    // Chart HTML reports layout + scale widths have stabilized.
                    // Lift the dim overlay here instead of on a fixed timer so
                    // the residual settle motion (price-scale width adjust,
                    // sub-pane widths, etc.) happens while still covered.
                    if (chartVisibleTimerRef.current) {
                      clearTimeout(chartVisibleTimerRef.current);
                      chartVisibleTimerRef.current = null;
                    }
                    // Reload watchdog ack: settle after __reloadChart means
                    // the in-place swap succeeded; cancel the forced remount.
                    reloadInFlightRef.current = false;
                    if (reloadWatchdogRef.current) {
                      clearTimeout(reloadWatchdogRef.current);
                      reloadWatchdogRef.current = null;
                    }
                    // Tiered settle watchdog ack — recovery not needed.
                    clearSettleWatchdog();
                    hardRemountCountRef.current = 0;
                    if (isActiveMode) {
                      setIsChartVisible(true);
                      // Flip the "first settle" flag so subsequent
                      // overlay flashes (interval switches, etc.) use
                      // the 55% dim overlay instead of the opaque
                      // loader. Only the very first boot needs to be
                      // fully covered.
                      setHasEverBeenSettled(true);
                    }
                    return;
                  }
                  if (msg?.type === 'viewport') {
                    if (!isActiveMode) return;
                    const timeRange = normalizeViewportRange(msg?.timeRange);
                    const logicalRange = normalizeViewportRange(msg?.logicalRange);
                    if (!timeRange && !logicalRange) return;
                    lastViewportRef.current = { timeRange, logicalRange };
                    return;
                  }
                  if (msg?.type === 'chart-error') {
                    // Cancel the reload watchdog — the WebView did respond
                    // (with an error). The existing chart-error retry path
                    // below will handle the actual recovery.
                    reloadInFlightRef.current = false;
                    if (reloadWatchdogRef.current) {
                      clearTimeout(reloadWatchdogRef.current);
                      reloadWatchdogRef.current = null;
                    }
                    // Cancel the tiered settle watchdog too — the error
                    // path below owns recovery (chartErrorCount + remount).
                    clearSettleWatchdog();
                    if (!isActiveMode) return;
                    const now = Date.now();
                    const msgText = String(msg?.msg || 'Chart error');
                    const isScriptError = /script error/i.test(msgText);
                    
                    // Throttle error logging to prevent console spam
                    if (now - lastChartErrorRef.current > 2000) {
                      console.warn('[Chart] WebView error:', msgText, msg?.detail || '');
                      lastChartErrorRef.current = now;
                    }
                    
                    // Don't retry for transient "Script error" - these are often CORS or timing issues
                    if (isScriptError) {
                      return;
                    }
                    
                    // For real errors, limit retries
                    chartErrorCountRef.current++;
                    if (chartErrorCountRef.current > 3) {
                      setChartError(`Chart failed to load (${lwcSource})`);
                      return;
                    }
                    
                    setIsWebViewReady(false);
                    setIsChartVisible(false);
                    if (chartVisibleTimerRef.current) { clearTimeout(chartVisibleTimerRef.current); chartVisibleTimerRef.current = null; }
                    setChartError(`${msgText} (${lwcSource})`);
                    setWebViewRetryKey((k) => k + 1);
                    return;
                  }
                  if (msg?.type === 'drawings-changed') {
                    const drawings = msg?.drawings || [];
                    savedDrawingsRef.current = drawings;
                    if (assetSymbol) saveDrawings(assetSymbol, drawings);
                    return;
                  }
                  if (msg?.type === 'request-drawings') {
                    if (mode !== 'expanded') return;
                    const d = savedDrawingsRef.current;
                    const ref = expandedWebViewRef.current;
                    if (ref && d && d.length > 0) {
                      ref.injectJavaScript(`(function(){try{window.__setDrawings&&window.__setDrawings(${JSON.stringify(d)});}catch(e){}return true;})();`);
                    }
                    return;
                  }
                  if (msg?.type === 'ind-toggle') {
                    setChartSettings((prev) => ({ ...prev, showIndValues: !!msg.open }));
                    return;
                  }
                  if (msg?.type === 'toggle-indicator-lines' && msg?.group) {
                    const g = String(msg.group) as MainIndicatorLineGroup;
                    const allowed = new Set(['ema', 'ma', 'boll', 'vwap', 'supertrend']);
                    if (!allowed.has(g)) return;
                    setChartSettings((prev) => {
                      const mv = { ...(prev.mainIndicatorLineVisibility || {}) };
                      const curOn = mv[g] !== false;
                      mv[g] = !curOn;
                      return { ...prev, mainIndicatorLineVisibility: mv };
                    });
                    return;
                  }
                  if (msg?.type === 'chart-interacting') {
                    setInteracting(!!msg.active);
                    return;
                  }
                  if (msg?.type !== 'requestMoreHistory') return;
                  if (!isActiveMode) return;
                  if (historyExhaustedRef.current) return;
                  const now = Date.now();
                  if (now - lastHistoryRequestRef.current < 1200) return;
                  lastHistoryRequestRef.current = now;
                  loadMoreHistory();
                } catch {
                  // ignore malformed messages
                }
              }}
            />
          ) : (
            // Pre-layout placeholder: this renders for the 1-frame window
            // between `lightweightChartHtml` becoming non-null and the
            // wrapper's onLayout firing to set `containerWidth`. We use the
            // same absolute-fill + centered style as `chartLoadingOverlay`
            // so the spinner is vertically centered in `lightweightContainer`
            // from the very first frame. Previously this used
            // `styles.chartPlaceholder` which has no height, so it collapsed
            // to ~38px and the spinner visibly jumped from the top of the
            // container down to center once the overlay took over.
            <View style={styles.chartLoadingOverlay}>
              <LoadingIndicator size="small" />
            </View>
          )}
          {chartError ? (
            <View style={styles.chartErrorOverlay}>
              <Text style={styles.chartErrorText}>{chartError}</Text>
              <TouchableOpacity
                style={styles.chartErrorButton}
                onPress={() => {
                  setChartError(null);
                  setWebViewRetryKey((k) => k + 1);
                }}
              >
                <Text style={styles.chartErrorButtonText}>Retry</Text>
              </TouchableOpacity>
            </View>
          ) : null}
          {(isSwitchingInterval || !isChartVisible) && hasEverBeenSettled ? (
            <View style={styles.chartDimOverlay} />
          ) : null}
          {!isChartVisible && !hasEverBeenSettled && mountedChartHtml && containerWidth > 0 ? (
            <View style={styles.chartLoadingOverlay}>
              <LoadingIndicator size="small" />
            </View>
          ) : null}
        </View>
      </View>
    );
  };

  useEffect(() => {
    if (!isWebViewReady) return;
    // Add a small delay to ensure WebView is fully ready
    const timeoutId = setTimeout(() => {
      const payload = JSON.stringify(indicatorState);
      injectChartScript(`window.__setIndicators && window.__setIndicators(${payload});`, 'both');
    }, 50);
    return () => clearTimeout(timeoutId);
  }, [indicatorState, injectChartScript, isWebViewReady, webViewReadyNonce]);

  useEffect(() => {
    if (!isWebViewReady) return;
    const payload = JSON.stringify({
      entryPx: entryPxNum,
      entryColor: entryLineColor,
      liqPx: liqPxNum,
      limitOrders: limitOrderLines,
    });
    injectChartScript(`window.__setOrderLines && window.__setOrderLines(${payload});`, 'both');
  }, [entryLineColor, entryPxNum, injectChartScript, isWebViewReady, limitOrderLines, liqPxNum, webViewReadyNonce]);

  useEffect(() => {
    if (!mountedChartHtml || !containerWidth) return;
    if (webViewReadyTimeoutRef.current) {
      clearTimeout(webViewReadyTimeoutRef.current);
    }
    webViewReadyTimeoutRef.current = setTimeout(() => {
      const activeInstance = isChartExpanded ? expandedWebViewRef.current : inlineWebViewRef.current;
      if (!isWebViewReady || !activeInstance) {
        setWebViewRetryKey((k) => k + 1);
      }
    }, 2500);
    return () => {
      if (webViewReadyTimeoutRef.current) {
        clearTimeout(webViewReadyTimeoutRef.current);
        webViewReadyTimeoutRef.current = null;
      }
    };
  }, [chartKey, containerWidth, isChartExpanded, isWebViewReady, mountedChartHtml]);

  useEffect(() => {
    if (!isWebViewReady) return;
    const effectiveSettings = {
      ...chartSettings,
      drawingEnabled: isChartExpanded && expandedDrawMode,
    };
    const payload = JSON.stringify(effectiveSettings);
    setTimeout(() => {
      injectChartScript(`window.__setChartSettings && window.__setChartSettings(${payload});`, 'both');
    }, 10);
  }, [chartSettings, expandedDrawMode, isChartExpanded, injectChartScript, isWebViewReady, webViewReadyNonce]);

  useEffect(() => {
    if (!isWebViewReady) return;
    const payload = JSON.stringify(drawTool);
    injectChartScript(`window.__setDrawTool && window.__setDrawTool(${payload});`, 'both');
  }, [drawTool, injectChartScript, isWebViewReady, webViewReadyNonce]);

  return (
    <>
      <View style={[styles.intervalContainer, noHorizontalMargin && styles.intervalContainerNoMargin]}>
        <Animated.View style={[styles.intervalScrollWrap, { opacity: intervalRowOpacity }]}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.intervalScrollContent}
          >
            {pinnedIntervals.map((interval) => (
              <TouchableOpacity
                key={interval}
                style={[
                  styles.intervalButton,
                  selectedInterval === interval && styles.intervalButtonActive,
                ]}
                onPress={() => handleIntervalChange(interval)}
              >
                <Text
                  style={[
                    styles.intervalText,
                    selectedInterval === interval && styles.intervalTextActive,
                  ]}
                >
                  {interval}
                </Text>
              </TouchableOpacity>
            ))}
            {!pinnedIntervals.includes(selectedInterval) && (
              <View style={styles.selectedIntervalBadge}>
                <Text style={styles.selectedIntervalText}>{selectedInterval}</Text>
              </View>
            )}
          </ScrollView>
          <LinearGradient
            colors={[`${colors.background.primary}00`, colors.background.primary]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.intervalFade}
            pointerEvents="none"
          />
        </Animated.View>
        <TouchableOpacity
          style={styles.intervalChevronButton}
          onPress={() => setIsIntervalMenuOpen((prev) => !prev)}
        >
          <Ionicons
            name="chevron-down"
            size={16}
            color={isIntervalMenuOpen ? colors.accent.gold : colors.text.secondary}
          />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.intervalIconButton}
          onPress={toggleChartExpanded}
        >
          <Ionicons name="expand-outline" size={16} color={colors.text.secondary} />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.intervalIconButton}
          onPress={() => setIsSettingsOpen(true)}
        >
          <Ionicons name="settings-outline" size={16} color={colors.text.secondary} />
        </TouchableOpacity>
      </View>
      <Modal transparent visible={isIntervalMenuOpen} animationType="fade">
        <Pressable style={styles.intervalBackdrop} onPress={() => setIsIntervalMenuOpen(false)}>
          <Pressable style={[styles.intervalSheet, { paddingBottom: 16 + Math.max(0, insets.bottom) }]} onStartShouldSetResponder={() => true}>
            <Text style={styles.intervalTitle}>{t('trading.intervals')}</Text>
            <Text style={styles.intervalSection}>{t('trading.pinnedIntervals')}</Text>
            <View style={styles.intervalSheetRow}>
              {sortedIntervals.map((interval) => {
                const pinned = pinnedIntervals.includes(interval);
                return (
                  <TouchableOpacity
                    key={`pin-${interval}`}
                    style={[
                      styles.intervalMenuButton,
                      pinned && styles.intervalPinnedButton,
                    ]}
                    onPress={() => handleIntervalMenuPress(interval)}
                  >
                    <View style={styles.intervalPinnedRow}>
                      <Text style={[
                        styles.intervalText,
                        pinned && styles.intervalPinnedText,
                      ]}>
                        {interval}
                      </Text>
                      {pinned ? <Ionicons name="checkmark-circle" size={12} color={colors.accent.gold} /> : null}
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
            <Text style={styles.intervalHint}>{t('trading.pinnedTapToPinUnpin')}</Text>
            {/* No separate "Other intervals" list; pin/unpin covers all intervals */}
          </Pressable>
        </Pressable>
      </Modal>

      <Modal transparent visible={isIndicatorsOpen} animationType="fade">
        <KeyboardAvoidingView
          style={styles.indicatorKeyboardRoot}
          behavior={Platform.OS === 'ios' ? 'padding' : 'padding'}
          keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top + 8 : Math.max(0, insets.bottom)}
        >
          <Pressable
            style={styles.modalBackdropFill}
            onPress={() => {
              Keyboard.dismiss();
              if (maColorPick) { setMaColorPick(null); return; }
              if (maSourcePick) { setMaSourcePick(null); return; }
              setIsIndicatorsOpen(false);
            }}
          />
          <Pressable
            style={[
              styles.indicatorSheet,
              {
                paddingBottom: 24 + Math.max(0, insets.bottom),
                maxHeight: SCREEN_HEIGHT * 0.84,
                marginTop: Math.max(44, insets.top + 12),
              },
            ]}
            onStartShouldSetResponder={() => true}
          >
            <ScrollView
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              showsVerticalScrollIndicator
              bounces={false}
              contentContainerStyle={{
                paddingBottom: 24 + Math.max(0, insets.bottom) + chartModalKeyboardHeight,
              }}
            >
            <View style={styles.indicatorHeader}>
              <Text style={styles.indicatorTitle}>{t('trading.indicators')}</Text>
              <TouchableOpacity onPress={() => setIsIndicatorsOpen(false)} style={styles.indicatorCloseBtn}>
                <Ionicons name="close" size={18} color={colors.text.primary} />
              </TouchableOpacity>
            </View>

            <Text style={styles.indicatorSection}>{t('trading.mainChart')}</Text>
            <View style={styles.maEditorCard}>
              <View style={styles.maTabBar}>
                {(['ema', 'ma'] as const).map((tab) => {
                  const isActive = mainAverageTab === tab;
                  return (
                    <TouchableOpacity
                      key={tab}
                      style={[styles.maTab, isActive && styles.maTabActive]}
                      onPress={() => setMainAverageTab(tab)}
                      activeOpacity={0.85}
                    >
                      <Text style={[styles.maTabText, isActive && styles.maTabTextActive]}>
                        {tab.toUpperCase()}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <View style={[styles.bollShowRow, styles.maMasterShowRow]}>
                <Text style={styles.bollShowLabel}>{t('trading.bollShowOnChart')}</Text>
                <TouchableOpacity
                  onPress={toggleMainAverageMasterVisible}
                  style={styles.maBandCheckHit}
                  hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
                >
                  <Ionicons
                    name={
                      (mainAverageTab === 'ema'
                        ? chartSettings.mainIndicatorLineVisibility?.ema
                        : chartSettings.mainIndicatorLineVisibility?.ma) !== false
                        ? 'checkbox'
                        : 'square-outline'
                    }
                    size={22}
                    color={
                      (mainAverageTab === 'ema'
                        ? chartSettings.mainIndicatorLineVisibility?.ema
                        : chartSettings.mainIndicatorLineVisibility?.ma) !== false
                        ? colors.accent.gold
                        : colors.text.tertiary
                    }
                  />
                </TouchableOpacity>
              </View>
              <View style={styles.maBandsFlat}>
                {(mainAverageTab === 'ema' ? indicatorState.emaRows : indicatorState.maRows)
                  .slice(0, MA_BAND_SLOT_COUNT)
                  .map((row, index) => (
                    <View
                      key={`${mainAverageTab}-${index}`}
                      style={[styles.maBandRow, index > 0 && styles.maBandRowBorder]}
                    >
                      <TouchableOpacity
                        onPress={() => toggleMaBandEnabled(mainAverageTab, index)}
                        style={styles.maBandCheckHit}
                        hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
                      >
                        <Ionicons
                          name={row.enabled ? 'checkbox' : 'square-outline'}
                          size={20}
                          color={row.enabled ? colors.accent.gold : colors.text.tertiary}
                        />
                      </TouchableOpacity>
                      <Text style={styles.maBandSlotLabel} numberOfLines={1}>
                        {mainAverageTab === 'ema' ? `EMA${index + 1}` : `MA${index + 1}`}
                      </Text>
                      <TextInput
                        style={styles.maBandPeriodInput}
                        value={String(row.period)}
                        keyboardType="number-pad"
                        selectTextOnFocus
                        maxLength={3}
                        onChangeText={(txt) => {
                          const cleaned = txt.replace(/[^0-9]/g, '');
                          setMaBandPeriodText(mainAverageTab, index, cleaned);
                        }}
                      />
                      <TouchableOpacity
                        style={styles.maSourceSelect}
                        onPress={() => {
                          Keyboard.dismiss();
                          setMaSourcePick({ group: mainAverageTab, index });
                        }}
                        activeOpacity={0.85}
                      >
                        <Text style={styles.maSourceSelectText} numberOfLines={1}>
                          {t(
                            MA_SOURCE_OPTIONS.find((o) => o.id === row.source)?.labelKey ?? 'trading.maSourceClose',
                          )}
                        </Text>
                        <Ionicons name="chevron-down" size={14} color={colors.text.secondary} />
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.maColorSwatch, { borderColor: row.color }]}
                        onPress={() => {
                          Keyboard.dismiss();
                          setMaColorPick({ group: mainAverageTab, index });
                        }}
                        activeOpacity={0.85}
                      >
                        <View style={[styles.maColorSwatchInner, { backgroundColor: row.color }]} />
                      </TouchableOpacity>
                    </View>
                  ))}
              </View>
              <View style={styles.maEditorFooter}>
                <TouchableOpacity style={styles.maEditorResetBtn} onPress={resetMainAverageTab}>
                  <Text style={styles.maEditorResetText}>{t('trading.maReset')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.maEditorDoneBtn}
                  onPress={() => setIsIndicatorsOpen(false)}
                >
                  <Text style={styles.maEditorDoneText}>{t('trading.done')}</Text>
                </TouchableOpacity>
              </View>
            </View>
            </ScrollView>
          </Pressable>

          {maSourcePick ? (
            <Pressable style={styles.pickerOverlayBackdrop} onPress={() => setMaSourcePick(null)}>
              <Pressable
                style={[styles.maSourcePickSheet, { paddingBottom: 20 + Math.max(0, insets.bottom) }]}
                onStartShouldSetResponder={() => true}
              >
                <Text style={styles.indicatorTitle}>{t('trading.maPriceSource')}</Text>
                {MA_SOURCE_OPTIONS.map((opt) => {
                  const rows = maSourcePick.group === 'ema' ? indicatorState.emaRows : indicatorState.maRows;
                  const cur = rows[maSourcePick.index];
                  const active = cur?.source === opt.id;
                  return (
                    <TouchableOpacity
                      key={opt.id}
                      style={[styles.maSourcePickRow, active && styles.maSourcePickRowActive]}
                      onPress={() => {
                        updateMaBandRow(maSourcePick.group, maSourcePick.index, { source: opt.id });
                        setMaSourcePick(null);
                      }}
                    >
                      <Text style={[styles.maSourcePickRowText, active && styles.maSourcePickRowTextActive]}>
                        {t(opt.labelKey)}
                      </Text>
                      {active ? <Ionicons name="checkmark" size={18} color={colors.accent.gold} /> : null}
                    </TouchableOpacity>
                  );
                })}
              </Pressable>
            </Pressable>
          ) : null}

          {maColorPick ? (
            <Pressable style={styles.pickerOverlayBackdrop} onPress={() => setMaColorPick(null)}>
              <Pressable
                style={[styles.colorPickSheet, { paddingBottom: 20 + Math.max(0, insets.bottom) }]}
                onStartShouldSetResponder={() => true}
              >
                <Text style={styles.indicatorTitle}>{t('trading.pickColor')}</Text>
                <View style={styles.colorPickGrid}>
                  {CHART_COLOR_PRESETS.map((c, i) => (
                    <TouchableOpacity
                      key={`cp-${i}-${c}`}
                      style={[styles.colorPickDot, { backgroundColor: c }]}
                      onPress={() => {
                        updateMaBandRow(maColorPick.group, maColorPick.index, { color: c });
                        setMaColorPick(null);
                      }}
                    />
                  ))}
                </View>
              </Pressable>
            </Pressable>
          ) : null}
        </KeyboardAvoidingView>
      </Modal>

      <Modal transparent visible={isBollModalOpen} animationType="fade">
        <KeyboardAvoidingView
          style={styles.indicatorKeyboardRoot}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={0}
        >
          <Pressable
            style={styles.modalBackdropFill}
            onPress={() => {
              Keyboard.dismiss();
              if (bollColorPick) {
                setBollColorPick(null);
                return;
              }
              if (bollLineStylePick) {
                setBollLineStylePick(null);
                return;
              }
              setIsBollModalOpen(false);
            }}
          />
          <Pressable
            style={[
              styles.indicatorSheet,
              {
                paddingBottom: 24 + Math.max(0, insets.bottom),
                maxHeight: SCREEN_HEIGHT * 0.84,
                marginTop: Math.max(44, insets.top + 12),
              },
            ]}
            onStartShouldSetResponder={() => true}
          >
            <ScrollView
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              showsVerticalScrollIndicator
              bounces={false}
            >
              <View style={[styles.indicatorHeader, styles.modalSheetHeaderGap]}>
                <Text style={styles.indicatorTitle}>{t('trading.bollSettings')}</Text>
                <TouchableOpacity
                  onPress={() => setIsBollModalOpen(false)}
                  style={styles.indicatorCloseBtn}
                >
                  <Ionicons name="close" size={18} color={colors.text.primary} />
                </TouchableOpacity>
              </View>

              <View style={[styles.bollShowRow, styles.maEditorCard]}>
                <Text style={styles.bollShowLabel}>{t('trading.bollShowOnChart')}</Text>
                <TouchableOpacity
                  onPress={() => setIndicatorState((prev) => ({ ...prev, boll: !prev.boll }))}
                  style={styles.maBandCheckHit}
                  hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
                >
                  <Ionicons
                    name={indicatorState.boll ? 'checkbox' : 'square-outline'}
                    size={22}
                    color={indicatorState.boll ? colors.accent.gold : colors.text.tertiary}
                  />
                </TouchableOpacity>
              </View>

              <Text style={styles.indicatorSection}>{t('trading.bollParameters')}</Text>
              <View style={[styles.bollParamsRow, styles.maEditorCard]}>
                <View style={styles.bollParamCell}>
                  <Text style={styles.bollParamLabel}>{t('trading.bollLength')}</Text>
                  <TextInput
                    style={styles.bollParamInput}
                    value={bollCfg.length === 0 ? '' : String(bollCfg.length)}
                    keyboardType="number-pad"
                    selectTextOnFocus
                    maxLength={3}
                    onChangeText={setBollLengthText}
                  />
                </View>
                <View style={styles.bollParamCell}>
                  <Text style={styles.bollParamLabel}>{t('trading.bollMultiplier')}</Text>
                  <TextInput
                    style={styles.bollParamInput}
                    value={String(bollCfg.multiplier)}
                    keyboardType={Platform.OS === 'ios' ? 'decimal-pad' : 'numeric'}
                    selectTextOnFocus
                    maxLength={6}
                    onChangeText={setBollMultiplierText}
                  />
                </View>
              </View>

              <Text style={styles.indicatorSection}>{t('trading.bollDisplay')}</Text>
              <View style={styles.maEditorCard}>
                <View style={[styles.bollDisplayRow, styles.bollDisplayRowBorder]}>
                  <TouchableOpacity
                    onPress={() => patchBollConfig({ showBackground: !bollCfg.showBackground })}
                    style={styles.maBandCheckHit}
                    hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
                  >
                    <Ionicons
                      name={bollCfg.showBackground ? 'checkbox' : 'square-outline'}
                      size={20}
                      color={bollCfg.showBackground ? colors.accent.gold : colors.text.tertiary}
                    />
                  </TouchableOpacity>
                  <Text style={styles.bollBandLabel}>{t('trading.bollBackground')}</Text>
                  <TouchableOpacity
                    style={[styles.maColorSwatch, { borderColor: bollCfg.backgroundColor }]}
                    onPress={() => {
                      Keyboard.dismiss();
                      setBollColorPick('background');
                    }}
                    activeOpacity={0.85}
                  >
                    <View style={[styles.maColorSwatchInner, { backgroundColor: bollCfg.backgroundColor }]} />
                  </TouchableOpacity>
                </View>

                {(
                  [
                    ['upper', 'trading.bollUpper', 'showUpper', 'upperColor', 'upperLineStyle'] as const,
                    ['mid', 'trading.bollMiddle', 'showMid', 'midColor', 'midLineStyle'] as const,
                    ['lower', 'trading.bollLower', 'showLower', 'lowerColor', 'lowerLineStyle'] as const,
                  ] as const
                ).map(([key, labelKey, showKey, colorKey, styleKey], idx) => {
                  const show = bollCfg[showKey as keyof typeof bollCfg] as boolean;
                  const lineColor = bollCfg[colorKey as keyof typeof bollCfg] as string;
                  const lineStyle = bollCfg[styleKey as keyof typeof bollCfg] as 0 | 1 | 2 | 3 | 4;
                  return (
                    <View
                      key={key}
                      style={[styles.bollDisplayRow, idx < 2 && styles.bollDisplayRowBorder]}
                    >
                      <TouchableOpacity
                        onPress={() =>
                          patchBollConfig({
                            [showKey]: !show,
                          } as Partial<BollConfig>)
                        }
                        style={styles.maBandCheckHit}
                        hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
                      >
                        <Ionicons
                          name={show ? 'checkbox' : 'square-outline'}
                          size={20}
                          color={show ? colors.accent.gold : colors.text.tertiary}
                        />
                      </TouchableOpacity>
                      <Text style={styles.bollBandLabel}>{t(labelKey)}</Text>
                      <TouchableOpacity
                        style={styles.bollLineStyleBtn}
                        onPress={() => {
                          Keyboard.dismiss();
                          setBollLineStylePick(key as 'upper' | 'mid' | 'lower');
                        }}
                        activeOpacity={0.85}
                      >
                        <Text style={styles.maSourceSelectText} numberOfLines={1}>
                          {t(
                            BOLL_LINE_STYLE_OPTIONS.find((o) => o.id === lineStyle)?.labelKey ??
                              'trading.lineStyleSolid',
                          )}
                        </Text>
                        <Ionicons name="chevron-down" size={14} color={colors.text.secondary} />
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.maColorSwatch, { borderColor: lineColor }]}
                        onPress={() => {
                          Keyboard.dismiss();
                          setBollColorPick(key as 'upper' | 'mid' | 'lower');
                        }}
                        activeOpacity={0.85}
                      >
                        <View style={[styles.maColorSwatchInner, { backgroundColor: lineColor }]} />
                      </TouchableOpacity>
                    </View>
                  );
                })}
              </View>

              <View style={styles.maEditorFooter}>
                <TouchableOpacity style={styles.maEditorResetBtn} onPress={resetBollConfigToDefault}>
                  <Text style={styles.maEditorResetText}>{t('trading.maReset')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.maEditorDoneBtn}
                  onPress={() => setIsBollModalOpen(false)}
                >
                  <Text style={styles.maEditorDoneText}>{t('trading.done')}</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          </Pressable>

          {bollLineStylePick ? (
            <Pressable style={styles.pickerOverlayBackdrop} onPress={() => setBollLineStylePick(null)}>
              <Pressable
                style={[styles.maSourcePickSheet, { paddingBottom: 20 + Math.max(0, insets.bottom) }]}
                onStartShouldSetResponder={() => true}
              >
                <Text style={styles.indicatorTitle}>{t('trading.bollLineStyle')}</Text>
                {BOLL_LINE_STYLE_OPTIONS.map((opt) => {
                  const cur =
                    bollLineStylePick === 'upper'
                      ? bollCfg.upperLineStyle
                      : bollLineStylePick === 'mid'
                        ? bollCfg.midLineStyle
                        : bollCfg.lowerLineStyle;
                  const active = cur === opt.id;
                  return (
                    <TouchableOpacity
                      key={opt.id}
                      style={[styles.maSourcePickRow, active && styles.maSourcePickRowActive]}
                      onPress={() => {
                        const patch: Partial<BollConfig> =
                          bollLineStylePick === 'upper'
                            ? { upperLineStyle: opt.id }
                            : bollLineStylePick === 'mid'
                              ? { midLineStyle: opt.id }
                              : { lowerLineStyle: opt.id };
                        patchBollConfig(patch);
                        setBollLineStylePick(null);
                      }}
                    >
                      <Text style={[styles.maSourcePickRowText, active && styles.maSourcePickRowTextActive]}>
                        {t(opt.labelKey)}
                      </Text>
                      {active ? <Ionicons name="checkmark" size={18} color={colors.accent.gold} /> : null}
                    </TouchableOpacity>
                  );
                })}
              </Pressable>
            </Pressable>
          ) : null}

          {bollColorPick ? (
            <Pressable style={styles.pickerOverlayBackdrop} onPress={() => setBollColorPick(null)}>
              <Pressable
                style={[styles.colorPickSheet, { paddingBottom: 20 + Math.max(0, insets.bottom) }]}
                onStartShouldSetResponder={() => true}
              >
                <Text style={styles.indicatorTitle}>
                  {bollColorPick === 'background' ? t('trading.bollPickBackground') : t('trading.pickColor')}
                </Text>
                <View style={styles.colorPickGrid}>
                  {(bollColorPick === 'background' ? BOLL_BG_SWATCHES : CHART_COLOR_PRESETS).map((c, i) => (
                    <TouchableOpacity
                      key={`boll-cp-${bollColorPick}-${i}-${c}`}
                      style={[styles.colorPickDot, { backgroundColor: c }]}
                      onPress={() => {
                        if (bollColorPick === 'background') {
                          patchBollConfig({ backgroundColor: c });
                        } else if (bollColorPick === 'upper') {
                          patchBollConfig({ upperColor: c });
                        } else if (bollColorPick === 'mid') {
                          patchBollConfig({ midColor: c });
                        } else {
                          patchBollConfig({ lowerColor: c });
                        }
                        setBollColorPick(null);
                      }}
                    />
                  ))}
                </View>
              </Pressable>
            </Pressable>
          ) : null}
        </KeyboardAvoidingView>
      </Modal>

      <Modal transparent visible={isVwapModalOpen} animationType="fade">
        <KeyboardAvoidingView
          style={styles.indicatorKeyboardRoot}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={0}
        >
          <Pressable
            style={styles.modalBackdropFill}
            onPress={() => {
              Keyboard.dismiss();
              if (vwapColorPickOpen) {
                setVwapColorPickOpen(false);
                return;
              }
              if (vwapLineStylePickOpen) {
                setVwapLineStylePickOpen(false);
                return;
              }
              setIsVwapModalOpen(false);
            }}
          />
          <Pressable
            style={[
              styles.indicatorSheet,
              {
                paddingBottom: 24 + Math.max(0, insets.bottom),
                maxHeight: SCREEN_HEIGHT * 0.72,
                marginTop: Math.max(44, insets.top + 12),
              },
            ]}
            onStartShouldSetResponder={() => true}
          >
            <ScrollView
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              showsVerticalScrollIndicator
              bounces={false}
            >
              <View style={[styles.indicatorHeader, styles.modalSheetHeaderGap]}>
                <Text style={styles.indicatorTitle}>{t('trading.vwapSettings')}</Text>
                <TouchableOpacity
                  onPress={() => setIsVwapModalOpen(false)}
                  style={styles.indicatorCloseBtn}
                >
                  <Ionicons name="close" size={18} color={colors.text.primary} />
                </TouchableOpacity>
              </View>

              <View style={[styles.bollShowRow, styles.maEditorCard]}>
                <Text style={styles.bollShowLabel}>{t('trading.bollShowOnChart')}</Text>
                <TouchableOpacity
                  onPress={() => setIndicatorState((prev) => ({ ...prev, vwap: !prev.vwap }))}
                  style={styles.maBandCheckHit}
                  hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
                >
                  <Ionicons
                    name={indicatorState.vwap ? 'checkbox' : 'square-outline'}
                    size={22}
                    color={indicatorState.vwap ? colors.accent.gold : colors.text.tertiary}
                  />
                </TouchableOpacity>
              </View>

              <Text style={styles.indicatorSection}>{t('trading.bollParameters')}</Text>
              <View style={[styles.bollParamsRow, styles.maEditorCard]}>
                <View style={styles.bollParamCell}>
                  <Text style={styles.bollParamLabel}>{t('trading.bollLength')}</Text>
                  <TextInput
                    style={styles.bollParamInput}
                    value={vwapCfg.length === 0 ? '' : String(vwapCfg.length)}
                    keyboardType="number-pad"
                    selectTextOnFocus
                    maxLength={3}
                    onChangeText={setVwapLengthText}
                  />
                </View>
              </View>

              <Text style={styles.indicatorSection}>{t('trading.bollDisplay')}</Text>
              <View style={styles.maEditorCard}>
                <View style={[styles.vwapStyleRow, styles.bollDisplayRowBorder]}>
                  <Text style={styles.vwapLineWidthRowLabel} numberOfLines={1}>
                    {t('trading.vwapLineWidth')}
                  </Text>
                  <View style={styles.vwapWidthChips}>
                    {VWAP_LINE_WIDTH_OPTIONS.map((w) => {
                      const active = vwapCfg.lineWidth === w;
                      return (
                        <TouchableOpacity
                          key={`vwap-lw-${w}`}
                          style={[styles.vwapWidthChip, active && styles.vwapWidthChipActive]}
                          onPress={() => patchVwapConfig({ lineWidth: w })}
                          activeOpacity={0.85}
                        >
                          <Text style={[styles.vwapWidthChipText, active && styles.vwapWidthChipTextActive]}>
                            {w}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
                <View style={[styles.bollDisplayRow, styles.bollDisplayRowBorder]}>
                  <Text style={styles.bollBandLabel}>{t('trading.bollLineStyle')}</Text>
                  <TouchableOpacity
                    style={styles.bollLineStyleBtn}
                    onPress={() => {
                      Keyboard.dismiss();
                      setVwapLineStylePickOpen(true);
                    }}
                    activeOpacity={0.85}
                  >
                    <Text style={styles.maSourceSelectText} numberOfLines={1}>
                      {t(
                        BOLL_LINE_STYLE_OPTIONS.find((o) => o.id === vwapCfg.lineStyle)?.labelKey ??
                          'trading.lineStyleSolid',
                      )}
                    </Text>
                    <Ionicons name="chevron-down" size={14} color={colors.text.secondary} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.maColorSwatch, { borderColor: vwapCfg.color }]}
                    onPress={() => {
                      Keyboard.dismiss();
                      setVwapColorPickOpen(true);
                    }}
                    activeOpacity={0.85}
                  >
                    <View style={[styles.maColorSwatchInner, { backgroundColor: vwapCfg.color }]} />
                  </TouchableOpacity>
                </View>
              </View>

              <View style={styles.maEditorFooter}>
                <TouchableOpacity style={styles.maEditorResetBtn} onPress={resetVwapConfigToDefault}>
                  <Text style={styles.maEditorResetText}>{t('trading.maReset')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.maEditorDoneBtn}
                  onPress={() => setIsVwapModalOpen(false)}
                >
                  <Text style={styles.maEditorDoneText}>{t('trading.done')}</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          </Pressable>

          {vwapLineStylePickOpen ? (
            <Pressable style={styles.pickerOverlayBackdrop} onPress={() => setVwapLineStylePickOpen(false)}>
              <Pressable
                style={[styles.maSourcePickSheet, { paddingBottom: 20 + Math.max(0, insets.bottom) }]}
                onStartShouldSetResponder={() => true}
              >
                <Text style={styles.indicatorTitle}>{t('trading.bollLineStyle')}</Text>
                {BOLL_LINE_STYLE_OPTIONS.map((opt) => {
                  const active = vwapCfg.lineStyle === opt.id;
                  return (
                    <TouchableOpacity
                      key={`vwap-ls-${opt.id}`}
                      style={[styles.maSourcePickRow, active && styles.maSourcePickRowActive]}
                      onPress={() => {
                        patchVwapConfig({ lineStyle: opt.id });
                        setVwapLineStylePickOpen(false);
                      }}
                    >
                      <Text style={[styles.maSourcePickRowText, active && styles.maSourcePickRowTextActive]}>
                        {t(opt.labelKey)}
                      </Text>
                      {active ? <Ionicons name="checkmark" size={18} color={colors.accent.gold} /> : null}
                    </TouchableOpacity>
                  );
                })}
              </Pressable>
            </Pressable>
          ) : null}

          {vwapColorPickOpen ? (
            <Pressable style={styles.pickerOverlayBackdrop} onPress={() => setVwapColorPickOpen(false)}>
              <Pressable
                style={[styles.colorPickSheet, { paddingBottom: 20 + Math.max(0, insets.bottom) }]}
                onStartShouldSetResponder={() => true}
              >
                <Text style={styles.indicatorTitle}>{t('trading.pickColor')}</Text>
                <View style={styles.colorPickGrid}>
                  {CHART_COLOR_PRESETS.map((c, i) => (
                    <TouchableOpacity
                      key={`vwap-cp-${i}-${c}`}
                      style={[styles.colorPickDot, { backgroundColor: c }]}
                      onPress={() => {
                        patchVwapConfig({ color: c });
                        setVwapColorPickOpen(false);
                      }}
                    />
                  ))}
                </View>
              </Pressable>
            </Pressable>
          ) : null}
        </KeyboardAvoidingView>
      </Modal>

      <Modal transparent visible={isStModalOpen} animationType="fade">
        <KeyboardAvoidingView
          style={styles.indicatorKeyboardRoot}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={0}
        >
          <Pressable
            style={styles.modalBackdropFill}
            onPress={() => {
              Keyboard.dismiss();
              if (stColorPickOpen) {
                setStColorPickOpen(false);
                return;
              }
              if (stLineStylePickOpen) {
                setStLineStylePickOpen(false);
                return;
              }
              setIsStModalOpen(false);
            }}
          />
          <Pressable
            style={[
              styles.indicatorSheet,
              {
                paddingBottom: 24 + Math.max(0, insets.bottom),
                maxHeight: SCREEN_HEIGHT * 0.72,
                marginTop: Math.max(44, insets.top + 12),
              },
            ]}
            onStartShouldSetResponder={() => true}
          >
            <ScrollView
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              showsVerticalScrollIndicator
              bounces={false}
            >
              <View style={[styles.indicatorHeader, styles.modalSheetHeaderGap]}>
                <Text style={styles.indicatorTitle}>{t('trading.stSettings')}</Text>
                <TouchableOpacity
                  onPress={() => setIsStModalOpen(false)}
                  style={styles.indicatorCloseBtn}
                >
                  <Ionicons name="close" size={18} color={colors.text.primary} />
                </TouchableOpacity>
              </View>

              <View style={[styles.bollShowRow, styles.maEditorCard]}>
                <Text style={styles.bollShowLabel}>{t('trading.bollShowOnChart')}</Text>
                <TouchableOpacity
                  onPress={() => setIndicatorState((prev) => ({ ...prev, supertrend: !prev.supertrend }))}
                  style={styles.maBandCheckHit}
                  hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
                >
                  <Ionicons
                    name={indicatorState.supertrend ? 'checkbox' : 'square-outline'}
                    size={22}
                    color={indicatorState.supertrend ? colors.accent.gold : colors.text.tertiary}
                  />
                </TouchableOpacity>
              </View>

              <Text style={styles.indicatorSection}>{t('trading.bollParameters')}</Text>
              <View style={[styles.bollParamsRow, styles.maEditorCard]}>
                <View style={styles.bollParamCell}>
                  <Text style={styles.bollParamLabel}>{t('trading.stAtrPeriod')}</Text>
                  <TextInput
                    style={styles.bollParamInput}
                    value={stCfg.period === 0 ? '' : String(stCfg.period)}
                    keyboardType="number-pad"
                    selectTextOnFocus
                    maxLength={3}
                    onChangeText={setStPeriodText}
                  />
                </View>
                <View style={styles.bollParamCell}>
                  <Text style={styles.bollParamLabel}>{t('trading.bollMultiplier')}</Text>
                  <TextInput
                    style={styles.bollParamInput}
                    value={String(stCfg.multiplier)}
                    keyboardType="decimal-pad"
                    selectTextOnFocus
                    onChangeText={setStMultiplierText}
                  />
                </View>
              </View>

              <Text style={styles.indicatorSection}>{t('trading.bollDisplay')}</Text>
              <View style={styles.maEditorCard}>
                <View style={[styles.vwapStyleRow, styles.bollDisplayRowBorder]}>
                  <Text style={styles.vwapLineWidthRowLabel} numberOfLines={1}>
                    {t('trading.vwapLineWidth')}
                  </Text>
                  <View style={styles.vwapWidthChips}>
                    {VWAP_LINE_WIDTH_OPTIONS.map((w) => {
                      const active = stCfg.lineWidth === w;
                      return (
                        <TouchableOpacity
                          key={`st-lw-${w}`}
                          style={[styles.vwapWidthChip, active && styles.vwapWidthChipActive]}
                          onPress={() => patchStConfig({ lineWidth: w })}
                          activeOpacity={0.85}
                        >
                          <Text style={[styles.vwapWidthChipText, active && styles.vwapWidthChipTextActive]}>
                            {w}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
                <View style={[styles.bollDisplayRow, styles.bollDisplayRowBorder]}>
                  <Text style={styles.bollBandLabel}>{t('trading.bollLineStyle')}</Text>
                  <TouchableOpacity
                    style={styles.bollLineStyleBtn}
                    onPress={() => {
                      Keyboard.dismiss();
                      setStLineStylePickOpen(true);
                    }}
                    activeOpacity={0.85}
                  >
                    <Text style={styles.maSourceSelectText} numberOfLines={1}>
                      {t(
                        BOLL_LINE_STYLE_OPTIONS.find((o) => o.id === stCfg.lineStyle)?.labelKey ??
                          'trading.lineStyleSolid',
                      )}
                    </Text>
                    <Ionicons name="chevron-down" size={14} color={colors.text.secondary} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.maColorSwatch, { borderColor: stCfg.color }]}
                    onPress={() => {
                      Keyboard.dismiss();
                      setStColorPickOpen(true);
                    }}
                    activeOpacity={0.85}
                  >
                    <View style={[styles.maColorSwatchInner, { backgroundColor: stCfg.color }]} />
                  </TouchableOpacity>
                </View>
              </View>

              <View style={styles.maEditorFooter}>
                <TouchableOpacity style={styles.maEditorResetBtn} onPress={resetStConfigToDefault}>
                  <Text style={styles.maEditorResetText}>{t('trading.maReset')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.maEditorDoneBtn}
                  onPress={() => setIsStModalOpen(false)}
                >
                  <Text style={styles.maEditorDoneText}>{t('trading.done')}</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          </Pressable>

          {stLineStylePickOpen ? (
            <Pressable style={styles.pickerOverlayBackdrop} onPress={() => setStLineStylePickOpen(false)}>
              <Pressable
                style={[styles.maSourcePickSheet, { paddingBottom: 20 + Math.max(0, insets.bottom) }]}
                onStartShouldSetResponder={() => true}
              >
                <Text style={styles.indicatorTitle}>{t('trading.bollLineStyle')}</Text>
                {BOLL_LINE_STYLE_OPTIONS.map((opt) => {
                  const active = stCfg.lineStyle === opt.id;
                  return (
                    <TouchableOpacity
                      key={`st-ls-${opt.id}`}
                      style={[styles.maSourcePickRow, active && styles.maSourcePickRowActive]}
                      onPress={() => {
                        patchStConfig({ lineStyle: opt.id });
                        setStLineStylePickOpen(false);
                      }}
                    >
                      <Text style={[styles.maSourcePickRowText, active && styles.maSourcePickRowTextActive]}>
                        {t(opt.labelKey)}
                      </Text>
                      {active ? <Ionicons name="checkmark" size={18} color={colors.accent.gold} /> : null}
                    </TouchableOpacity>
                  );
                })}
              </Pressable>
            </Pressable>
          ) : null}

          {stColorPickOpen ? (
            <Pressable style={styles.pickerOverlayBackdrop} onPress={() => setStColorPickOpen(false)}>
              <Pressable
                style={[styles.colorPickSheet, { paddingBottom: 20 + Math.max(0, insets.bottom) }]}
                onStartShouldSetResponder={() => true}
              >
                <Text style={styles.indicatorTitle}>{t('trading.pickColor')}</Text>
                <View style={styles.colorPickGrid}>
                  {CHART_COLOR_PRESETS.map((c, i) => (
                    <TouchableOpacity
                      key={`st-cp-${i}-${c}`}
                      style={[styles.colorPickDot, { backgroundColor: c }]}
                      onPress={() => {
                        patchStConfig({ color: c });
                        setStColorPickOpen(false);
                      }}
                    />
                  ))}
                </View>
              </Pressable>
            </Pressable>
          ) : null}
        </KeyboardAvoidingView>
      </Modal>

      <Modal transparent visible={isRsiModalOpen} animationType="fade">
        <KeyboardAvoidingView
          style={styles.indicatorKeyboardRoot}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={0}
        >
          <Pressable
            style={styles.modalBackdropFill}
            onPress={() => {
              Keyboard.dismiss();
              if (rsiColorPick !== null) {
                setRsiColorPick(null);
                return;
              }
              if (rsiLineStylePickIndex !== null) {
                setRsiLineStylePickIndex(null);
                return;
              }
              setIsRsiModalOpen(false);
            }}
          />
          <Pressable
            style={[
              styles.indicatorSheet,
              {
                paddingBottom: 24 + Math.max(0, insets.bottom),
                maxHeight: SCREEN_HEIGHT * 0.84,
                marginTop: Math.max(44, insets.top + 12),
              },
            ]}
            onStartShouldSetResponder={() => true}
          >
            <ScrollView
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              showsVerticalScrollIndicator
              bounces={false}
              contentContainerStyle={{
                paddingBottom: 24 + Math.max(0, insets.bottom) + chartModalKeyboardHeight,
              }}
            >
              <View style={[styles.indicatorHeader, styles.modalSheetHeaderGap]}>
                <Text style={styles.indicatorTitle}>{t('trading.rsiSettingsTitle')}</Text>
                <TouchableOpacity
                  onPress={() => setIsRsiModalOpen(false)}
                  style={styles.indicatorCloseBtn}
                >
                  <Ionicons name="close" size={18} color={colors.text.primary} />
                </TouchableOpacity>
              </View>

              <View style={[styles.bollShowRow, styles.maEditorCard]}>
                <Text style={styles.bollShowLabel}>{t('trading.bollShowOnChart')}</Text>
                <TouchableOpacity
                  onPress={() => setIndicatorState((prev) => ({ ...prev, rsi: !prev.rsi }))}
                  style={styles.maBandCheckHit}
                  hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
                >
                  <Ionicons
                    name={indicatorState.rsi ? 'checkbox' : 'square-outline'}
                    size={22}
                    color={indicatorState.rsi ? colors.accent.gold : colors.text.tertiary}
                  />
                </TouchableOpacity>
              </View>

              <Text style={styles.indicatorSection}>{t('trading.rsiLinesSection')}</Text>
              <View style={styles.maBandsFlat}>
                {indicatorState.rsiRows.slice(0, RSI_BAND_SLOT_COUNT).map((row, index) => (
                  <View
                    key={`rsi-row-${index}`}
                    style={[styles.rsiModalLineBlock, index > 0 && styles.maBandRowBorder]}
                  >
                    {/*
                      Binance-style single row: period (value) + line style + color only.
                      PRICE SOURCE — re-enable: add `const [rsiSourcePick, setRsiSourcePick] = useState<number | null>(null);`
                      and uncomment the TouchableOpacity + rsiSourcePick overlay block below.
                    */}
                    <View style={styles.rsiBinanceRow}>
                      <TouchableOpacity
                        onPress={() => toggleRsiBandEnabled(index)}
                        style={styles.maBandCheckHit}
                        hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
                      >
                        <Ionicons
                          name={row.enabled ? 'checkbox' : 'square-outline'}
                          size={20}
                          color={row.enabled ? colors.accent.gold : colors.text.tertiary}
                        />
                      </TouchableOpacity>
                      <Text style={styles.maBandSlotLabel} numberOfLines={1}>
                        RSI
                      </Text>
                      <TextInput
                        style={styles.maBandPeriodInput}
                        value={row.period === 0 ? '' : String(row.period)}
                        keyboardType="number-pad"
                        selectTextOnFocus
                        maxLength={3}
                        onChangeText={(txt) => {
                          const cleaned = txt.replace(/[^0-9]/g, '');
                          setRsiBandPeriodText(index, cleaned);
                        }}
                      />
                      {/*
                      <TouchableOpacity
                        style={styles.maSourceSelect}
                        onPress={() => {
                          Keyboard.dismiss();
                          setRsiSourcePick(index);
                        }}
                        activeOpacity={0.85}
                      >
                        <Text style={styles.maSourceSelectText} numberOfLines={1}>
                          {t(
                            MA_SOURCE_OPTIONS.find((o) => o.id === row.source)?.labelKey ?? 'trading.maSourceClose',
                          )}
                        </Text>
                        <Ionicons name="chevron-down" size={14} color={colors.text.secondary} />
                      </TouchableOpacity>
                      */}
                      <TouchableOpacity
                        style={styles.bollLineStyleBtn}
                        onPress={() => {
                          Keyboard.dismiss();
                          setRsiLineStylePickIndex(index);
                        }}
                        activeOpacity={0.85}
                      >
                        <Text style={styles.maSourceSelectText} numberOfLines={1}>
                          {t(
                            BOLL_LINE_STYLE_OPTIONS.find((o) => o.id === row.lineStyle)?.labelKey ??
                              'trading.lineStyleSolid',
                          )}
                        </Text>
                        <Ionicons name="chevron-down" size={14} color={colors.text.secondary} />
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.maColorSwatch, { borderColor: row.color }]}
                        onPress={() => {
                          Keyboard.dismiss();
                          setRsiColorPick(index);
                        }}
                        activeOpacity={0.85}
                      >
                        <View style={[styles.maColorSwatchInner, { backgroundColor: row.color }]} />
                      </TouchableOpacity>
                    </View>
                    {/*
                      LINE WIDTH (line strength) — re-enable chips + rsiSourcePick overlay if needed.
                    <View style={styles.rsiWidthRow}>
                      <Text style={styles.rsiWidthRowLabel}>{t('trading.vwapLineWidth')}</Text>
                      <View style={styles.vwapWidthChips}>
                        {VWAP_LINE_WIDTH_OPTIONS.map((w) => {
                          const active = row.lineWidth === w;
                          return (
                            <TouchableOpacity
                              key={`rsi-lw-${index}-${w}`}
                              style={[styles.vwapWidthChip, active && styles.vwapWidthChipActive]}
                              onPress={() => updateRsiBandRow(index, { lineWidth: w })}
                              activeOpacity={0.85}
                            >
                              <Text style={[styles.vwapWidthChipText, active && styles.vwapWidthChipTextActive]}>
                                {w}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    </View>
                    */}
                  </View>
                ))}
              </View>

              <View style={styles.maEditorFooter}>
                <TouchableOpacity style={styles.maEditorResetBtn} onPress={resetRsiRows}>
                  <Text style={styles.maEditorResetText}>{t('trading.maReset')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.maEditorDoneBtn}
                  onPress={() => setIsRsiModalOpen(false)}
                >
                  <Text style={styles.maEditorDoneText}>{t('trading.done')}</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          </Pressable>

          {rsiLineStylePickIndex !== null ? (
            <Pressable style={styles.pickerOverlayBackdrop} onPress={() => setRsiLineStylePickIndex(null)}>
              <Pressable
                style={[styles.maSourcePickSheet, { paddingBottom: 20 + Math.max(0, insets.bottom) }]}
                onStartShouldSetResponder={() => true}
              >
                <Text style={styles.indicatorTitle}>{t('trading.bollLineStyle')}</Text>
                {BOLL_LINE_STYLE_OPTIONS.map((opt) => {
                  const cur = indicatorState.rsiRows[rsiLineStylePickIndex];
                  const active = cur?.lineStyle === opt.id;
                  return (
                    <TouchableOpacity
                      key={`rsi-ls-${rsiLineStylePickIndex}-${opt.id}`}
                      style={[styles.maSourcePickRow, active && styles.maSourcePickRowActive]}
                      onPress={() => {
                        updateRsiBandRow(rsiLineStylePickIndex, { lineStyle: opt.id });
                        setRsiLineStylePickIndex(null);
                      }}
                    >
                      <Text style={[styles.maSourcePickRowText, active && styles.maSourcePickRowTextActive]}>
                        {t(opt.labelKey)}
                      </Text>
                      {active ? <Ionicons name="checkmark" size={18} color={colors.accent.gold} /> : null}
                    </TouchableOpacity>
                  );
                })}
              </Pressable>
            </Pressable>
          ) : null}

          {/*
            RSI PRICE SOURCE overlay — re-enable with rsiSourcePick state (see row comment above).
          {rsiSourcePick !== null ? (
            <Pressable style={styles.pickerOverlayBackdrop} onPress={() => setRsiSourcePick(null)}>
              <Pressable
                style={[styles.maSourcePickSheet, { paddingBottom: 20 + Math.max(0, insets.bottom) }]}
                onStartShouldSetResponder={() => true}
              >
                <Text style={styles.indicatorTitle}>{t('trading.maPriceSource')}</Text>
                {MA_SOURCE_OPTIONS.map((opt) => {
                  const cur = indicatorState.rsiRows[rsiSourcePick];
                  const active = cur?.source === opt.id;
                  return (
                    <TouchableOpacity
                      key={`rsi-src-${rsiSourcePick}-${opt.id}`}
                      style={[styles.maSourcePickRow, active && styles.maSourcePickRowActive]}
                      onPress={() => {
                        updateRsiBandRow(rsiSourcePick, { source: opt.id });
                        setRsiSourcePick(null);
                      }}
                    >
                      <Text style={[styles.maSourcePickRowText, active && styles.maSourcePickRowTextActive]}>
                        {t(opt.labelKey)}
                      </Text>
                      {active ? <Ionicons name="checkmark" size={18} color={colors.accent.gold} /> : null}
                    </TouchableOpacity>
                  );
                })}
              </Pressable>
            </Pressable>
          ) : null}
          */}

          {rsiColorPick !== null ? (
            <Pressable style={styles.pickerOverlayBackdrop} onPress={() => setRsiColorPick(null)}>
              <Pressable
                style={[styles.colorPickSheet, { paddingBottom: 20 + Math.max(0, insets.bottom) }]}
                onStartShouldSetResponder={() => true}
              >
                <Text style={styles.indicatorTitle}>{t('trading.pickColor')}</Text>
                <View style={styles.colorPickGrid}>
                  {CHART_COLOR_PRESETS.map((c, i) => (
                    <TouchableOpacity
                      key={`rsi-cp-${rsiColorPick}-${i}-${c}`}
                      style={[styles.colorPickDot, { backgroundColor: c }]}
                      onPress={() => {
                        updateRsiBandRow(rsiColorPick, { color: c });
                        setRsiColorPick(null);
                      }}
                    />
                  ))}
                </View>
              </Pressable>
            </Pressable>
          ) : null}
        </KeyboardAvoidingView>
      </Modal>

      <Modal transparent visible={isSettingsOpen} animationType="fade">
        <Pressable style={styles.indicatorBackdrop} onPress={() => setIsSettingsOpen(false)}>
          <Pressable style={[styles.indicatorSheet, { paddingBottom: 24 + Math.max(0, insets.bottom) }]} onStartShouldSetResponder={() => true}>
            <View style={styles.settingsHeader}>
              <Text style={styles.indicatorTitle}>{t('trading.chartSettings')}</Text>
              <TouchableOpacity onPress={() => setIsSettingsOpen(false)} style={styles.settingsCloseButton}>
                <Ionicons name="close" size={18} color={colors.text.primary} />
              </TouchableOpacity>
            </View>

            <Text style={styles.indicatorSection}>{t('trading.timeZone')}</Text>
            <View style={styles.settingsRow}>
              <TouchableOpacity
                style={[styles.settingsOption, chartSettings.useUtc && styles.settingsOptionActive]}
                onPress={() => setChartSettings((prev) => ({ ...prev, useUtc: true }))}
              >
                <Text style={[styles.settingsOptionText, chartSettings.useUtc && styles.settingsOptionTextActive]}>UTC (0)</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.settingsOption, !chartSettings.useUtc && styles.settingsOptionActive]}
                onPress={() => setChartSettings((prev) => ({ ...prev, useUtc: false }))}
              >
                <Text style={[styles.settingsOptionText, !chartSettings.useUtc && styles.settingsOptionTextActive]}>{t('trading.local')}</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.indicatorSection}>{t('trading.chartMode') || 'Chart Mode'}</Text>
            <View style={styles.settingsRow}>
              <TouchableOpacity
                style={[styles.settingsOption, chartSettings.chartMode !== 'line' && styles.settingsOptionActive]}
                onPress={() => setChartSettings((prev) => ({ ...prev, chartMode: 'candle' as const }))}
              >
                <Text style={[styles.settingsOptionText, chartSettings.chartMode !== 'line' && styles.settingsOptionTextActive]}>
                  {t('trading.candlestick') || 'Candlestick'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.settingsOption, chartSettings.chartMode === 'line' && styles.settingsOptionActive]}
                onPress={() => setChartSettings((prev) => ({ ...prev, chartMode: 'line' as const }))}
              >
                <Text style={[styles.settingsOptionText, chartSettings.chartMode === 'line' && styles.settingsOptionTextActive]}>
                  {t('trading.smoothLine') || 'Smooth Line'}
                </Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.indicatorSection}>{t('trading.overlays')}</Text>
            <View style={styles.settingsToggleRow}>
              <Text style={styles.settingsLabel}>{t('trading.entryLimitLines')}</Text>
              <TouchableOpacity
                style={[styles.settingsToggle, chartSettings.showOrderLines && styles.settingsToggleOn]}
                onPress={() => setChartSettings((prev) => ({ ...prev, showOrderLines: !prev.showOrderLines }))}
              >
                <Text style={[styles.settingsToggleText, chartSettings.showOrderLines && styles.settingsToggleTextOn]}>
                  {chartSettings.showOrderLines ? t('trading.on') : t('trading.off')}
                </Text>
              </TouchableOpacity>
            </View>
            <View style={styles.settingsToggleRow}>
              <Text style={styles.settingsLabel}>{t('trading.highLowLabels')}</Text>
              <TouchableOpacity
                style={[styles.settingsToggle, chartSettings.showHighLow && styles.settingsToggleOn]}
                onPress={() => setChartSettings((prev) => ({ ...prev, showHighLow: !prev.showHighLow }))}
              >
                <Text style={[styles.settingsToggleText, chartSettings.showHighLow && styles.settingsToggleTextOn]}>
                  {chartSettings.showHighLow ? t('trading.on') : t('trading.off')}
                </Text>
              </TouchableOpacity>
            </View>
            <View style={styles.settingsToggleRow}>
              <Text style={styles.settingsLabel}>{t('trading.ohlcvHud', { defaultValue: 'OHLCVN values' })}</Text>
              <TouchableOpacity
                style={[styles.settingsToggle, chartSettings.showOhlcvHud !== false && styles.settingsToggleOn]}
                onPress={() => setChartSettings((prev) => ({ ...prev, showOhlcvHud: !(prev.showOhlcvHud !== false) }))}
              >
                <Text style={[styles.settingsToggleText, chartSettings.showOhlcvHud !== false && styles.settingsToggleTextOn]}>
                  {chartSettings.showOhlcvHud !== false ? t('trading.on') : t('trading.off')}
                </Text>
              </TouchableOpacity>
            </View>
            {/*<View style={styles.settingsToggleRow}>
              <Text style={styles.settingsLabel}>{t('trading.showTradeMarkers')}</Text>
              <TouchableOpacity
                style={[styles.settingsToggle, chartSettings.showTradeMarkers === true && styles.settingsToggleOn]}
                onPress={() =>
                  setChartSettings((prev) => ({
                    ...prev,
                    showTradeMarkers: !(prev.showTradeMarkers === true),
                  }))
                }
              >
                <Text
                  style={[
                    styles.settingsToggleText,
                    chartSettings.showTradeMarkers === true && styles.settingsToggleTextOn,
                  ]}
                >
                  {chartSettings.showTradeMarkers === true ? t('trading.on') : t('trading.off')}
                </Text>
              </TouchableOpacity>
            </View>
            */}
            <TouchableOpacity
              style={styles.settingsResetButton}
              onPress={() => {
                injectChartScript('window.__resetView && window.__resetView();', 'both');
                setIsSettingsOpen(false);
              }}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel={t('trading.maReset')}
            >
              <Ionicons name="refresh" size={18} color={colors.accent.gold} />
              <Text style={styles.settingsResetButtonText}>{t('trading.maReset')}</Text>
            </TouchableOpacity>

            {/*
            <Text style={styles.indicatorSection}>Tools</Text>
            <View style={styles.settingsToggleRow}>
              <Text style={styles.settingsLabel}>Drawing tool (tap to place)</Text>
              <TouchableOpacity
                style={[styles.settingsToggle, chartSettings.drawingEnabled && styles.settingsToggleOn]}
                onPress={() => setChartSettings((prev) => ({ ...prev, drawingEnabled: !prev.drawingEnabled }))}
              >
                <Text style={[styles.settingsToggleText, chartSettings.drawingEnabled && styles.settingsToggleTextOn]}>
                  {chartSettings.drawingEnabled ? 'On' : 'Off'}
                </Text>
              </TouchableOpacity>
            </View>
            <View style={styles.settingsToggleRow}>
              <Text style={styles.settingsLabel}>Clear drawings</Text>
              <TouchableOpacity
                style={styles.settingsToggle}
                onPress={() => {
                  injectChartScript('window.__clearDrawings && window.__clearDrawings();', 'both');
                }}
              >
                <Text style={styles.settingsToggleText}>Clear</Text>
              </TouchableOpacity>
            </View>
            */}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Chart */}
      {!isChartExpanded
        ? (candlesLoading && !initialCandles)
          ? (
            <View style={[styles.chartPlaceholder, { height: INLINE_CHART_TOTAL_HEIGHT + 24 }]}>
              <LoadingIndicator size="small" />
            </View>
          )
          : renderLightweightChart('inline')
        : null}
      {!isChartExpanded ? (
        <View style={[styles.subIndicatorBar, noHorizontalMargin && styles.subIndicatorBarNoMargin]}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.subIndicatorBarContent}
          >
            <TouchableOpacity
              style={styles.subIndicatorItem}
              onPress={() => setIsIndicatorsOpen(true)}
              activeOpacity={0.7}
            >
              <Text style={[styles.subIndicatorText, emaActive && styles.subIndicatorTextActive]}>EMA</Text>
            </TouchableOpacity>
            <View style={styles.subIndicatorSep} />
            <TouchableOpacity
              style={styles.subIndicatorItem}
              onPress={() => {
                setMainAverageTab('ma');
                setIsIndicatorsOpen(true);
              }}
              activeOpacity={0.7}
            >
              <Text style={[styles.subIndicatorText, maActive && styles.subIndicatorTextActive]}>MA</Text>
            </TouchableOpacity>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <View style={styles.subIndicatorSep} />
              <TouchableOpacity
                style={styles.subIndicatorItem}
                onPress={() => setIsBollModalOpen(true)}
                activeOpacity={0.7}
              >
                <Text
                  style={[styles.subIndicatorText, indicatorState.boll && styles.subIndicatorTextActive]}
                >
                  BOLL
                </Text>
              </TouchableOpacity>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <View style={styles.subIndicatorSep} />
              <TouchableOpacity
                style={styles.subIndicatorItem}
                onPress={() => setIsVwapModalOpen(true)}
                activeOpacity={0.7}
              >
                <Text
                  style={[styles.subIndicatorText, indicatorState.vwap && styles.subIndicatorTextActive]}
                >
                  VWAP
                </Text>
              </TouchableOpacity>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <View style={styles.subIndicatorSep} />
              <TouchableOpacity
                style={styles.subIndicatorItem}
                onPress={() => setIsStModalOpen(true)}
                activeOpacity={0.7}
              >
                <Text
                  style={[styles.subIndicatorText, indicatorState.supertrend && styles.subIndicatorTextActive]}
                >
                  ST
                </Text>
              </TouchableOpacity>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <View style={styles.subIndicatorSep} />
              <TouchableOpacity
                style={styles.subIndicatorItem}
                onPress={() => setIsRsiModalOpen(true)}
                activeOpacity={0.7}
              >
                <Text
                  style={[styles.subIndicatorText, indicatorState.rsi && styles.subIndicatorTextActive]}
                >
                  RSI
                </Text>
              </TouchableOpacity>
            </View>
            {(
              [
                ['vol', 'VOL'],
                ['macd', 'MACD'],
                ['cci', 'CCI'],
              ] as const
            ).map(([key, label]) => (
              <View key={key} style={{ flexDirection: 'row', alignItems: 'center' }}>
                <View style={styles.subIndicatorSep} />
                <TouchableOpacity
                  style={styles.subIndicatorItem}
                  onPress={() => handleToggleSimpleIndicator(key)}
                  activeOpacity={0.7}
                >
                  <Text
                    style={[
                      styles.subIndicatorText,
                      (indicatorState as any)[key] && styles.subIndicatorTextActive,
                    ]}
                  >
                    {label}
                  </Text>
                </TouchableOpacity>
              </View>
            ))}
          </ScrollView>
          <LinearGradient
            colors={[`${colors.background.primary}00`, colors.background.primary]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.subIndicatorFade}
            pointerEvents="none"
          />
        </View>
      ) : null}
      <Modal
        visible={isChartExpanded}
        animationType="slide"
        onRequestClose={closeExpandedChart}
        supportedOrientations={['portrait', 'landscape-left', 'landscape-right']}
      >
        <View style={[styles.chartExpandedScreen, styles.chartExpandedScreenLtr]}>
          {renderLightweightChart('expanded', true)}
          <View style={[styles.expandedSidebar, styles.expandedSidebarLtr, expandedSidebarPosition]}>
            <TouchableOpacity
              style={styles.expandedCloseBtn}
              onPress={closeExpandedChart}
              activeOpacity={0.7}
            >
              <Ionicons name="contract-outline" size={20} color={colors.text.primary} />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.expandedToolBtn}
              onPress={() => {
                injectChartScript('window.__resetView && window.__resetView();', 'both');
              }}
              activeOpacity={0.7}
            >
              <Ionicons name="refresh" size={16} color={colors.text.secondary} />
            </TouchableOpacity>
            {/* Drawing tools strip — visible by default in expanded
                mode. Each tool icon is its own toggle:
                  • inactive (gray) → tap to activate (starts drawing
                    mode with that tool selected).
                  • active (gold)   → tap again to deactivate (drawing
                    input is disabled, the icon greys out). The other
                    tool icons stay visible either way.
                Trash clears every confirmed drawing on the chart
                (both trendlines and fibos in one shot). The chevron
                at the end collapses the whole strip if the user
                wants a less busy sidebar. */}
            {expandedToolsCollapsed ? null : (
              <>
                <View style={styles.expandedToolDivider} />
                <TouchableOpacity
                  style={[
                    styles.expandedToolBtn,
                    expandedDrawMode && drawTool === 'trendline' && styles.expandedToolBtnActive,
                  ]}
                  onPress={() => {
                    if (Platform.OS !== 'web') Haptics.selectionAsync();
                    setExpandedDrawMode((prev) => {
                      if (prev && drawTool === 'trendline') return false;
                      setDrawTool('trendline');
                      return true;
                    });
                  }}
                  activeOpacity={0.7}
                >
                  <TrendlineIcon
                    color={
                      expandedDrawMode && drawTool === 'trendline'
                        ? colors.accent.gold
                        : colors.text.secondary
                    }
                  />
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.expandedToolBtn,
                    expandedDrawMode && drawTool === 'horizontal' && styles.expandedToolBtnActive,
                  ]}
                  onPress={() => {
                    if (Platform.OS !== 'web') Haptics.selectionAsync();
                    setExpandedDrawMode((prev) => {
                      if (prev && drawTool === 'horizontal') return false;
                      setDrawTool('horizontal');
                      return true;
                    });
                  }}
                  activeOpacity={0.7}
                >
                  <HorizontalIcon
                    color={
                      expandedDrawMode && drawTool === 'horizontal'
                        ? colors.accent.gold
                        : colors.text.secondary
                    }
                  />
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.expandedToolBtn,
                    expandedDrawMode && drawTool === 'fibo' && styles.expandedToolBtnActive,
                  ]}
                  onPress={() => {
                    if (Platform.OS !== 'web') Haptics.selectionAsync();
                    setExpandedDrawMode((prev) => {
                      if (prev && drawTool === 'fibo') return false;
                      setDrawTool('fibo');
                      return true;
                    });
                  }}
                  activeOpacity={0.7}
                >
                  <FiboIcon
                    color={
                      expandedDrawMode && drawTool === 'fibo'
                        ? colors.accent.gold
                        : colors.text.secondary
                    }
                  />
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.expandedToolBtn}
                  onPress={() => {
                    injectChartScript('window.__clearDrawings && window.__clearDrawings();', 'active');
                  }}
                  activeOpacity={0.7}
                >
                  <Ionicons name="trash-outline" size={16} color="#ef4444" />
                </TouchableOpacity>
              </>
            )}
            <View style={styles.expandedToolDivider} />
            <TouchableOpacity
              style={styles.expandedToolBtn}
              onPress={() => {
                setExpandedToolsCollapsed((prev) => !prev);
                if (Platform.OS !== 'web') Haptics.selectionAsync();
              }}
              activeOpacity={0.7}
            >
              <Ionicons
                name={expandedToolsCollapsed ? 'chevron-down' : 'chevron-up'}
                size={16}
                color={colors.text.secondary}
              />
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </>
  );
};

const styles = StyleSheet.create({
  intervalContainer: { flexDirection: 'row', paddingHorizontal: 16, gap: 6, marginBottom: 8, alignItems: 'center' },
  intervalContainerNoMargin: { paddingHorizontal: 0 },
  intervalScrollWrap: { flex: 1, flexShrink: 1, minWidth: 0, position: 'relative' },
  intervalFade: { position: 'absolute', right: 0, top: 0, bottom: 0, width: 24 },
  intervalScrollContent: { flexDirection: 'row', gap: 6, alignItems: 'center', paddingRight: 4 },
  intervalButton: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: colors.background.tertiary, minWidth: 40, alignItems: 'center' },
  intervalChevronButton: { paddingHorizontal: 6, paddingVertical: 6, borderRadius: 8, backgroundColor: colors.background.tertiary, alignItems: 'center', justifyContent: 'center' },
  selectedIntervalBadge: { paddingHorizontal: 8, paddingVertical: 6, borderRadius: 8, backgroundColor: colors.accent.gold, alignItems: 'center', justifyContent: 'center' },
  selectedIntervalText: { fontSize: 11, fontWeight: '700', color: colors.background.primary },
  intervalButtonActive: { backgroundColor: colors.accent.gold },
  intervalText: { fontSize: 11, fontWeight: '600', color: colors.text.secondary },
  intervalTextActive: { color: colors.background.primary },
  intervalMenuButton: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: colors.background.tertiary, minWidth: 40, alignItems: 'center' },
  intervalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(10, 10, 15, 0.85)',
    justifyContent: 'flex-end',
  },
  intervalSheet: {
    backgroundColor: colors.background.secondary,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderColor: colors.border.primary,
  },
  intervalTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.text.primary,
    marginBottom: 10,
  },
  intervalSheetRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  intervalSection: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.text.tertiary,
    marginBottom: 6,
  },
  intervalPinnedButton: {
    backgroundColor: `${colors.accent.gold}20`,
    borderColor: colors.accent.gold,
  },
  intervalPinnedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  intervalPinnedText: {
    color: colors.accent.gold,
  },
  intervalHint: {
    fontSize: 11,
    color: colors.text.tertiary,
    marginTop: 6,
  },
  intervalIconButton: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: colors.background.tertiary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  indicatorKeyboardRoot: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  modalBackdropFill: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(10, 10, 15, 0.85)',
  },
  pickerOverlayBackdrop: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(10, 10, 15, 0.4)',
    zIndex: 40,
  },
  indicatorBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(10, 10, 15, 0.85)',
    justifyContent: 'flex-end',
  },
  indicatorSheet: {
    backgroundColor: colors.background.secondary,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 24,
    borderTopWidth: 1,
    borderColor: colors.border.primary,
  },
  indicatorHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  modalSheetHeaderGap: {
    marginBottom: 14,
  },
  indicatorTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.text.primary,
  },
  indicatorCloseBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.background.tertiary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  indicatorSection: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.text.tertiary,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: 14,
    marginBottom: 8,
  },
  indicatorGroup: {
    backgroundColor: colors.background.tertiary,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border.primary,
    overflow: 'hidden',
  },
  indicatorLabeledRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 10,
  },
  indicatorRowLabel: {
    fontSize: 12,
    fontWeight: '800',
    color: colors.text.secondary,
    width: 32,
  },
  indicatorPeriodRow: {
    flexDirection: 'row',
    flex: 1,
    gap: 6,
  },
  indicatorPeriodChip: {
    flex: 1,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: colors.background.primary,
    borderWidth: 1,
    borderColor: colors.border.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  indicatorPeriodChipActive: {
    backgroundColor: `${colors.accent.gold}18`,
    borderColor: colors.accent.gold,
  },
  indicatorPeriodText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.text.tertiary,
  },
  indicatorPeriodTextActive: {
    color: colors.accent.gold,
  },
  indicatorGroupDivider: {
    height: 1,
    backgroundColor: colors.border.primary,
    marginHorizontal: 12,
  },
  indicatorRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  indicatorRowGap: {
    height: 6,
  },
  indicatorChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: colors.background.tertiary,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  indicatorChipActive: {
    backgroundColor: `${colors.accent.gold}18`,
    borderColor: colors.accent.gold,
  },
  indicatorChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.text.secondary,
  },
  indicatorChipTextActive: {
    color: colors.accent.gold,
  },
  chartActions: {
    position: 'absolute',
    right: 34,
    bottom: 6,
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    zIndex: 25,
  },
  chartToolbar: {
    flexDirection: 'row',
    gap: 8,
  },
  chartToolButton: {
    width: 28,
    height: 28,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background.tertiary,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  chartToolButtonSm: {
    width: 20,
    height: 20,
    borderRadius: 6,
  },
  chartToolButtonActive: {
    borderColor: colors.accent.gold,
    backgroundColor: `${colors.accent.gold}15`,
  },
  chartToolButtonDisabled: {
    opacity: 0.5,
  },
  settingsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  settingsCloseButton: {
    padding: 4,
    borderRadius: 999,
  },
  settingsRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 6,
  },
  settingsOption: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
    backgroundColor: colors.background.tertiary,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  settingsOptionActive: {
    backgroundColor: `${colors.accent.gold}25`,
    borderColor: colors.accent.gold,
  },
  settingsOptionText: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.text.secondary,
  },
  settingsOptionTextActive: {
    color: colors.accent.gold,
  },
  settingsToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  settingsLabel: {
    color: colors.text.secondary,
    fontSize: 12,
    fontWeight: '700',
  },
  settingsToggle: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 10,
    backgroundColor: colors.background.tertiary,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  settingsToggleOn: {
    backgroundColor: `${colors.accent.gold}25`,
    borderColor: colors.accent.gold,
  },
  settingsToggleText: {
    color: colors.text.primary,
    fontSize: 11,
    fontWeight: '800',
  },
  settingsToggleTextOn: {
    color: colors.accent.gold,
  },
  settingsResetButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'flex-start',
    marginTop: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: colors.background.tertiary,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  settingsResetButtonText: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.text.primary,
  },
  subIndicatorBar: {
    marginHorizontal: CHART_PADDING,
    marginBottom: 8,
    borderBottomLeftRadius: 12,
    borderBottomRightRadius: 12,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderTopColor: colors.border.primary,
    borderLeftColor: colors.border.primary,
    borderRightColor: colors.border.primary,
    borderBottomColor: colors.border.primary,
    backgroundColor: colors.background.primary,
    overflow: 'hidden',
  },
  subIndicatorBarNoMargin: {
    marginHorizontal: 0,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
  },
  subIndicatorBarContent: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 7,
    paddingHorizontal: 4,
    gap: 0,
  },
  subIndicatorItem: {
    paddingHorizontal: 14,
    paddingVertical: 2,
  },
  subIndicatorSep: {
    width: 1,
    height: 12,
    backgroundColor: colors.border.primary,
  },
  subIndicatorText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.text.tertiary,
    letterSpacing: 0.2,
  },
  subIndicatorTextActive: {
    color: colors.text.primary,
    fontWeight: '800',
  },
  subIndicatorFade: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: 32,
    borderBottomRightRadius: 12,
  },
  chartWrapper: { 
    marginHorizontal: CHART_PADDING, 
    marginTop: 12,
    marginBottom: 0,
    backgroundColor: colors.background.primary,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    padding: 12,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: colors.border.primary,
    minWidth: 0,
    alignSelf: 'stretch',
    position: 'relative',
  },
  chartWrapperNoMargin: {
    marginHorizontal: 0,
  },
  chartWrapperExpanded: {
    flex: 1,
    marginHorizontal: 0,
    marginVertical: 0,
    borderRadius: 0,
    borderWidth: 0,
    paddingHorizontal: 12,
  },
  chartContainer: { 
    flexDirection: 'row', 
    height: CHART_HEIGHT,
  },
  lightweightContainer: {
    height: CHART_HEIGHT,
    borderRadius: 10,
    width: '100%',
    minWidth: 0,
  },
  lightweightContainerExpanded: {
    flex: 1,
    width: '100%',
    borderRadius: 10,
  },
  chartExpandedScreen: {
    flex: 1,
    backgroundColor: colors.background.primary,
  },
  chartExpandedScreenLtr: {
    direction: 'ltr',
  },
  chartDimOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(10, 14, 20, 0.55)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
  chartLoadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.background.primary,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 9,
    borderRadius: 10,
  },
  chartErrorOverlay: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 12,
    padding: 10,
    borderRadius: 10,
    backgroundColor: 'rgba(15, 15, 20, 0.92)',
    borderWidth: 1,
    borderColor: colors.status.error,
    alignItems: 'center',
    gap: 8,
  },
  chartErrorText: {
    color: colors.status.error,
    fontSize: 11,
    fontWeight: '700',
    textAlign: 'center',
  },
  chartErrorButton: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: colors.status.error,
  },
  chartErrorButtonText: {
    color: colors.background.primary,
    fontSize: 11,
    fontWeight: '800',
  },
  lightweightWebview: {
    backgroundColor: 'transparent',
    width: '100%',
    height: '100%',
    flex: 1,
  },
  priceLabels: { width: 58, justifyContent: 'space-between', paddingRight: 8 },
  priceLabel: { fontSize: 10, color: colors.text.tertiary },
  chartArea: { flex: 1, position: 'relative', overflow: 'hidden' },
  gridLine: { position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: colors.border.primary },
  barsContainer: { flexDirection: 'row', height: CHART_HEIGHT, alignItems: 'flex-start' },
  candleWrapper: { height: CHART_HEIGHT, position: 'relative', alignItems: 'center' },
  wick: { position: 'absolute', width: 1 },
  candleBody: { position: 'absolute', borderRadius: 1 },
  scrubLine: { position: 'absolute', top: 0, bottom: 0, width: 1, backgroundColor: colors.text.tertiary, opacity: 0.8 },
  entryLine: { position: 'absolute', left: 0, right: 0, height: 2, opacity: 0.9, shadowOpacity: 0.6, shadowRadius: 6, shadowOffset: { width: 0, height: 0 }, elevation: 2 },
  limitLine: { position: 'absolute', left: 0, right: 0, height: 0, borderTopWidth: 1, borderTopColor: colors.text.tertiary, borderStyle: 'dashed', opacity: 0.7 },
  livePricePill: { position: 'absolute', right: 6, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 10, backgroundColor: colors.background.primary, borderWidth: 1, borderColor: colors.border.primary },
  livePriceText: { fontSize: 11, fontWeight: '800', color: colors.text.primary },
  legendPill: { position: 'absolute', top: 10, left: 16, right: 16, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 10, backgroundColor: colors.background.primary, borderWidth: 1, borderColor: colors.border.primary },
  legendText: { fontSize: 12, fontWeight: '700', color: colors.text.primary },
  chartPlaceholder: { marginHorizontal: 16, marginTop: 12, marginBottom: 0, backgroundColor: colors.background.card, borderTopLeftRadius: 12, borderTopRightRadius: 12, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderBottomWidth: 0, borderColor: colors.border.primary, padding: 12, overflow: 'hidden' },
  chartPlaceholderExpanded: { height: '100%', marginHorizontal: 0, marginVertical: 0, borderRadius: 0, flex: 1 },
  chartPlaceholderNoMargin: { marginHorizontal: 0 },
  chartPlaceholderText: { color: colors.text.tertiary },
  expandedSidebar: {
    position: 'absolute',
    flexDirection: 'column',
    gap: 6,
    zIndex: 20,
  },
  expandedSidebarLtr: {
    direction: 'ltr',
  },
  expandedCloseBtn: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: `${colors.background.tertiary}DD`,
    borderWidth: 1,
    borderColor: colors.border.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  expandedToolBtn: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: `${colors.background.tertiary}DD`,
    borderWidth: 1,
    borderColor: colors.border.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  expandedToolBtnActive: {
    backgroundColor: `${colors.accent.gold}25`,
    borderColor: colors.accent.gold,
  },
  expandedToolDivider: {
    width: 20,
    height: 1,
    backgroundColor: colors.border.primary,
    alignSelf: 'center',
  },
  rsiQuickRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingTop: 10,
    paddingBottom: 2,
  },
  rsiQuickChip: {
    minWidth: 40,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background.primary,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  rsiQuickChipActive: {
    backgroundColor: `${colors.accent.gold}18`,
    borderColor: colors.accent.gold,
  },
  rsiQuickChipText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.text.tertiary,
  },
  rsiQuickChipTextActive: {
    color: colors.accent.gold,
  },
  maEditorCard: {
    backgroundColor: colors.background.tertiary,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border.primary,
    overflow: 'hidden',
    marginBottom: 4,
  },
  maTabBar: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: colors.border.primary,
  },
  maTab: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  maTabActive: {
    borderBottomColor: colors.accent.gold,
    backgroundColor: `${colors.accent.gold}10`,
  },
  maTabText: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.text.tertiary,
  },
  maTabTextActive: {
    color: colors.accent.gold,
  },
  maBandsFlat: {
    paddingHorizontal: 10,
    paddingTop: 6,
    paddingBottom: 4,
  },
  maBandRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 7,
  },
  maBandRowBorder: {
    borderTopWidth: 1,
    borderTopColor: colors.border.primary,
  },
  rsiModalLineBlock: {
    paddingBottom: 2,
  },
  /** Single horizontal row: checkbox + label + period + line style + color (Binance-style). */
  rsiBinanceRow: {
    flexDirection: 'row',
    flexWrap: 'nowrap',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  rsiWidthRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 34,
    paddingTop: 4,
    paddingBottom: 8,
  },
  rsiWidthRowLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.text.tertiary,
  },
  maBandCheckHit: {
    width: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  maBandSlotLabel: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.text.secondary,
    width: 44,
  },
  maBandPeriodInput: {
    minWidth: 44,
    maxWidth: 52,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border.primary,
    backgroundColor: colors.background.primary,
    color: colors.text.primary,
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'center',
  },
  maSourceSelect: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 100,
    maxWidth: 160,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border.primary,
    backgroundColor: colors.background.primary,
  },
  maSourceSelectText: {
    flex: 1,
    fontSize: 11,
    fontWeight: '700',
    color: colors.text.secondary,
  },
  maSourcePickSheet: {
    width: '100%',
    backgroundColor: colors.background.secondary,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopWidth: 1,
    borderColor: colors.border.primary,
    maxHeight: SCREEN_HEIGHT * 0.55,
  },
  maSourcePickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.primary,
  },
  maSourcePickRowActive: {
    backgroundColor: `${colors.accent.gold}08`,
  },
  maSourcePickRowText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text.primary,
  },
  maSourcePickRowTextActive: {
    color: colors.accent.gold,
    fontWeight: '700',
  },
  maColorSwatch: {
    width: 32,
    height: 28,
    borderRadius: 8,
    borderWidth: 2,
    padding: 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background.primary,
  },
  maColorSwatchInner: {
    flex: 1,
    alignSelf: 'stretch',
    minHeight: 18,
    borderRadius: 5,
  },
  maEditorFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: colors.border.primary,
    gap: 12,
  },
  maEditorResetBtn: {
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  maEditorResetText: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.text.secondary,
  },
  maEditorDoneBtn: {
    paddingVertical: 8,
    paddingHorizontal: 18,
    borderRadius: 10,
    backgroundColor: colors.accent.gold,
  },
  maEditorDoneText: {
    fontSize: 13,
    fontWeight: '800',
    color: colors.background.primary,
  },
  bollShowRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 4,
  },
  maMasterShowRow: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border.primary,
    marginBottom: 0,
  },
  bollShowLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.text.primary,
  },
  bollParamsRow: {
    flexDirection: 'row',
    gap: 10,
    padding: 10,
    marginBottom: 4,
  },
  bollParamCell: {
    flex: 1,
    gap: 6,
  },
  bollParamLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.text.tertiary,
    marginBottom: 4,
  },
  bollParamInput: {
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border.primary,
    backgroundColor: colors.background.primary,
    color: colors.text.primary,
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
  },
  bollDisplayRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 10,
  },
  bollDisplayRowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border.primary,
  },
  bollBandLabel: {
    fontSize: 12,
    fontWeight: '800',
    color: colors.text.secondary,
    minWidth: 88,
    flexGrow: 1,
  },
  bollLineStyleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 4,
    minWidth: 108,
    maxWidth: 140,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border.primary,
    backgroundColor: colors.background.primary,
  },
  vwapStyleRow: {
    flexDirection: 'row',
    flexWrap: 'nowrap',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 10,
  },
  /** Label beside 1–4 width chips (VWAP/ST); keeps chips on one row. */
  vwapLineWidthRowLabel: {
    fontSize: 12,
    fontWeight: '800',
    color: colors.text.secondary,
    flexShrink: 1,
    marginRight: 4,
    maxWidth: '42%',
  },
  vwapWidthChips: {
    flexDirection: 'row',
    flexWrap: 'nowrap',
    alignItems: 'center',
    gap: 6,
    flexGrow: 1,
    flexShrink: 0,
    justifyContent: 'flex-end',
  },
  vwapWidthChip: {
    minWidth: 30,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border.primary,
    backgroundColor: colors.background.primary,
    alignItems: 'center',
  },
  vwapWidthChipActive: {
    borderColor: colors.accent.gold,
    backgroundColor: `${colors.accent.gold}14`,
  },
  vwapWidthChipText: {
    fontSize: 13,
    fontWeight: '800',
    color: colors.text.secondary,
  },
  vwapWidthChipTextActive: {
    color: colors.accent.gold,
  },
  colorPickSheet: {
    width: '100%',
    backgroundColor: colors.background.secondary,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderColor: colors.border.primary,
  },
  colorPickGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 12,
    marginBottom: 4,
  },
  colorPickDot: {
    width: 36,
    height: 36,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: colors.border.primary,
  },
});
