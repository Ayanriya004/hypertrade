import React, { useState, useMemo, useCallback, useEffect, useRef, useTransition } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  ActivityIndicator,
  Platform,
  TextInput,
  Keyboard,
  ScrollView,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { colors } from '../theme/colors';
import { reportTrade } from '../lib/api';
import { LeverageSlider } from './LeverageSlider';
import { useLiveAssetCtxs, useLivePrices } from '../providers/WebSocketProvider';
import { getPriceLookupKeys, pickPrice } from '../lib/priceKeys';
import {
  ensureAgentKey,
  placeOrder,
  getSpotClearinghouseState,
  getSpotAssetData,
  getSpotBuilderFeeTenthsBps,
  placeSpotOrder,
  transferUsdBetweenSpotAndPerp,
  getUserFees,
  getHip3FeeParams,
  getPerpMarginSupport,
  getPerpMarginTiers,
  parseFeeRateDecimal,
  canUseCrossOnAsset,
  getPerpOrderAcceptanceError,
  isPooledAccountMode,
  isOrderAvailableHydrated,
  isWalletTypedDataSigningError,
  computeUnifiedSpotTransferableUsd,
  type Eip1193Provider,
  type HyperliquidAbstractionMode,
} from '../lib/hyperliquid';
import {
  computeProtocolFeeRates,
  DEFAULT_PERP_MAKER_RATE,
  DEFAULT_PERP_TAKER_RATE,
  DEFAULT_SPOT_MAKER_RATE,
  DEFAULT_SPOT_TAKER_RATE,
  parseDeployerFeeScale,
  resolveBaseFeeRate,
} from '../lib/hip3Fees';
import { useBuilderConfig } from '../providers/BuilderConfigProvider';
import { buildMaintenanceSchedule, estimateLiqPriceIsolated, estimateLiqPriceCross } from '../lib/hlMargin';
import { useAppStore } from '../store/appStore';

function formatPriceSmart(n: number): string {
  if (!Number.isFinite(n)) return '--';
  const abs = Math.abs(n);
  if (abs >= 100) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (abs >= 10) return n.toFixed(3);
  if (abs >= 1) return n.toFixed(3);
  if (abs >= 0.1) return n.toFixed(4);
  return n.toFixed(6);
}
import { humanizeHyperliquidError } from '../lib/hyperliquidErrors';
import { showToast } from '../lib/toast';
import { Analytics } from '../lib/analytics';
import { useQuery } from '@tanstack/react-query';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { getSavedLeverage, saveLeverageForSymbol, getSavedMarginType, saveMarginTypeForSymbol } from '../lib/leveragePrefs';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../providers/AuthContext';
import { SPOT_TOGGLE_WHITELIST } from '../lib/spotToggleWhitelist';
import { demoAllowsSpot } from '../lib/demo';
import { DemoBadge, useIsDemo } from './DemoMode';
import { CurrencyHint } from './CurrencyHint';
import { useSharedAiTradeGuard } from '../hooks/useSharedAiTradeGuard';
import { resolveVaultAddress } from '../lib/tradingBook';

type QuickTradeCardProps = {
  symbol: string;
  coin: string;
  markPx: string;
  oraclePx?: string;
  maxLeverage: number;
  isHip3?: boolean;
  growthMode?: boolean | null;
  /** HIP-3 deployer fee scale from meta; live HL meta overrides when available. */
  deployerFeeScale?: number | null;
  isSpotOnly?: boolean;
  hasSpot?: boolean;
  spotSymbol?: string | null;
  embeddedAddress: `0x${string}`;
  getUserWalletProvider?: () => Promise<Eip1193Provider>;
  /**
   * Cross-margin pool equity backing THIS asset's dex, in USD. Must come
   * from `crossMarginSummary.accountValue` for the specific HL dex the
   * asset trades on (key '' for main, dex name for HIP-3). Used as the
   * `accountValueUsd` input to `estimateLiqPriceCross`.
   *
   * MUST NOT include:
   *   • Spot balance (separate HL margin account).
   *   • Other dexes' equity (HL keeps each dex's cross pool independent
   *     under standard abstraction — a HIP-3 dex's equity does not back
   *     main-dex positions and vice versa).
   *   • Isolated-position equity within the same dex (`marginSummary`
   *     adds it to the cross summary; `crossMarginSummary` correctly
   *     excludes it).
   *
   * Mixing any of those layers inflates equity and pushes projected
   * liquidations toward unsafe-looking-but-actually-safer numbers, and
   * in compounding scenarios can flip the direction of change.
   */
  crossAccountValueUsd: number;
  /**
   * `crossMaintenanceMarginUsed` for THIS asset's dex pool — the sum of
   * every OPEN cross position's maintenance margin in the pool. Pairs
   * with `crossAccountValueUsd` to give the SHARED `margin_available`
   * scalar HL uses for every cross position in the pool:
   *
   *   margin_available = crossAccountValueUsd − crossMaintenanceMarginUsedUsd
   *
   * Without this, projecting a NEW position on an asset where the user
   * has no existing same-asset position ignores the maintenance margin
   * already locked up by their other cross positions, and the projected
   * liq comes back far too safe (e.g. previewed BTC short liq 96k vs.
   * real fill 89k when the user already had two other cross longs).
   *
   * Must come from `clearinghouseState.crossMaintenanceMarginUsed` for
   * the SAME dex as `crossAccountValueUsd` (key '' for main, dex name
   * for HIP-3 — same convention as the account-value field).
   */
  crossMaintenanceMarginUsedUsd: number;
  /**
   * HL account abstraction mode (`userAbstraction` endpoint). Determines
   * how cross-margin equity is pooled — see HyperliquidTradingState comment
   * in lib/hyperliquid.ts. The default for app.hyperliquid.xyz is
   * `unifiedAccount`, where ALL USDC-backed cross dexes share one pool.
   * `null` is treated as per-dex (safe fallback).
   */
  accountAbstractionMode?: HyperliquidAbstractionMode | null;
  /**
   * UNIFIED-MODE inputs. Used only when `accountAbstractionMode` is
   * `unifiedAccount` or `portfolioMargin`. In those modes per-dex
   * `crossMarginSummary.accountValue` is meaningless (per HL docs:
   * "Individual perp dex user states are not meaningful"); the truth is:
   *
   *   margin_available = unifiedSpotUsdcBalanceUsd
   *                    − unifiedTotalIsolatedMarginUsedUsd
   *                    − unifiedTotalCrossMaintenanceMarginUsedUsd  (with
   *                      Δ-replacement of this asset's existing maint by
   *                      the post-fill combined position's maint, handled
   *                      inside estimateLiqPriceCross's pool mode)
   *
   * Without these, projecting a NEW cross position on a HIP-3 dex (e.g.
   * TSLA on `xyz`) where the user has no existing same-dex cross position
   * fails the canCrossProject guard, falls through to isolated math, and
   * shows a wildly wrong liq (e.g. 373 estimate vs 900+ actual fill).
   */
  unifiedSpotUsdcBalanceUsd?: number;
  /** Estimated USDC locked by resting spot BUY orders, not raw spot-state hold. */
  unifiedSpotUsdcHoldUsd?: number;
  unifiedTotalIsolatedMarginUsedUsd?: number;
  unifiedTotalCrossMaintenanceMarginUsedUsd?: number;
  /**
   * Total INITIAL margin used across every dex (main + HIP-3). One half of
   * HL's `transfer_margin_required = max(initial, 0.10 × position_value)`
   * rule for unified `sendAsset(spot → <dex>)` transfers.
   */
  unifiedTotalCrossInitialMarginUsedUsd?: number;
  /**
   * Sum of `|positionValue|` across every cross position. The other half
   * of HL's transfer rule — at >10× leverage the `0.10 × position_value`
   * floor dominates `initial_margin_used` and is what HL actually
   * enforces on spot-out transfers in unified mode.
   */
  unifiedTotalCrossPositionValueUsd?: number;
  /**
   * Initial margin locked by RESTING limit orders (cross OR isolated).
   * HL doesn't surface these via `marginSummary.totalMarginUsed` until
   * the order fills, but it still reserves the margin from the spot pool
   * — without subtracting it here the slider/Max overstates how much HL
   * will let `sendAsset(spot → <dex>)` transfer.
   */
  unifiedRestingOrdersInitMarginUsd?: number;
  targetDexMarginAvailableUsd?: number;
  perpWithdrawableByDex?: Record<string, number>;
  /**
   * Main perp dex withdrawable USDC (`clearinghouseState.withdrawable` for
   * the main dex). Used as the source-side budget for JIT `sendAsset`
   * funding of HIP-3 orders in Standard account-abstraction mode.
   *
   * In unified / portfolio-margin modes HL routes JIT funding through spot
   * (`sendAsset(sourceDex: "spot")`) instead, sourcing from the unified
   * pool reflected in `unifiedSpotUsdcBalanceUsd` / margin-used props.
   */
  mainDexWithdrawableUsd?: number;
  withdrawableUsd: number;
  hasBalance: boolean;
  isAgentActive: boolean;
  /** True only when HL setup is complete for the current env: agent active + builder fee approved + unified/portfolio mode. */
  setupComplete?: boolean;
  isAuthenticated: boolean;
  onAuthRequired: () => void;
  onSetupRequired: () => void;
  /**
   * Callback after HL accepts the order. Can return a Promise that resolves
   * once the parent's refetches (openOrders / tradingState / fills) complete
   * — the submit button keeps its spinner until then so the UI doesn't flip
   * to idle before the new row lands in PortfolioTabs.
   */
  onOrderSuccess: () => void | Promise<void>;
  /** When set, shows an in-page success banner instead of the global toast (avoids WS/modal stacking jank). */
  onOrderSuccessAlert?: () => void;
  existingPosition?: {
    entryPx: number;
    side: 'long' | 'short';
    sizeUnits: number;
    leverage?: number;
    marginUsedUsd?: number;
    markPx?: number;
    marginType?: 'cross' | 'isolated';
    liquidationPx?: number | null;
  } | null;
  /**
   * Resting limit-order lock for the current asset. HL applies leverage
   * and margin mode at the asset level, so placing a market order while
   * a resting limit exists silently mutates the limit's settings
   * (cross→isolated, 20x→10x, etc). When this prop is set we mute the
   * conflicting margin mode pill and lock leverage to match.
   */
  restingOrderLock?: {
    marginType?: 'cross' | 'isolated';
    leverage?: number;
  } | null;
};

// Small clickable label decoration that matches the trade page's info-dot
// pattern (take profit / stop loss / fees). Draws a dashed underline under
// a text label so the user has a clear affordance that tapping the label
// reveals more context. Component is module-scoped so it doesn't re-render
// with every parent state change.
type DashedUnderlineProps = { text: string; textStyle?: any };
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
          if (width > 0 && Math.abs(width - textWidth) > 0.5) setTextWidth(width);
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

const SIZE_USD_PRESETS: { usd: number; label: string }[] = [
  { usd: 500, label: '$500' },
  { usd: 1000, label: '$1000' },
  { usd: 2000, label: '$2000' },
  { usd: 5000, label: '$5000' },
  { usd: 10000, label: '$10000' },
  { usd: 25000, label: '$25000' },
  { usd: 50000, label: '$50000' },
];

function parseUsdNotional(text: string): number {
  const cleaned = String(text ?? '').replace(/[^0-9.]/g, '');
  if (!cleaned) return NaN;
  const firstDot = cleaned.indexOf('.');
  const normalized =
    firstDot === -1
      ? cleaned
      : `${cleaned.slice(0, firstDot + 1)}${cleaned.slice(firstDot + 1).replace(/\./g, '')}`;
  return parseFloat(normalized);
}

function clampSizePct(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  return Math.max(0, Math.min(100, pct));
}

/** Whole percents stay integers; sub-1% keeps a fraction so $500 on a large book isn't "0%". */
function formatSizePctNumber(pct: number): string {
  const n = clampSizePct(pct);
  if (n <= 0) return '0';
  if (n < 0.1) {
    const two = n.toFixed(2);
    return two === '0.00' ? '<0.01' : two;
  }
  if (n < 1) return n.toFixed(1);
  if (Math.abs(n - Math.round(n)) < 0.05) return String(Math.round(n));
  return n.toFixed(1);
}

export function QuickTradeCard({
  symbol,
  coin,
  markPx,
  oraclePx: oraclePxProp,
  maxLeverage,
  isHip3,
  growthMode,
  deployerFeeScale,
  isSpotOnly = false,
  hasSpot = false,
  spotSymbol: spotSymbolProp,
  embeddedAddress,
  getUserWalletProvider,
  crossAccountValueUsd,
  crossMaintenanceMarginUsedUsd,
  accountAbstractionMode,
  unifiedSpotUsdcBalanceUsd,
  unifiedSpotUsdcHoldUsd,
  unifiedTotalIsolatedMarginUsedUsd,
  unifiedTotalCrossMaintenanceMarginUsedUsd,
  unifiedTotalCrossInitialMarginUsedUsd,
  unifiedTotalCrossPositionValueUsd,
  unifiedRestingOrdersInitMarginUsd,
  targetDexMarginAvailableUsd,
  perpWithdrawableByDex,
  mainDexWithdrawableUsd,
  withdrawableUsd,
  hasBalance,
  isAgentActive,
  setupComplete = isAgentActive,
  isAuthenticated,
  onAuthRequired,
  onSetupRequired,
  onOrderSuccess,
  onOrderSuccessAlert,
  existingPosition,
  restingOrderLock,
}: QuickTradeCardProps) {
  const { t } = useTranslation();
  const tradingEnv = useAppStore((s) => s.tradingEnv);
  const activeTradingBook = useAppStore((s) => s.activeTradingBook);
  /** HL sub vault for Dedicated book; undefined on Main. */
  const vaultAddress = resolveVaultAddress(activeTradingBook);
  const isDedicatedBook = !!vaultAddress;
  /** Address for fees / spot / leverage prefs — sub when Dedicated, else master. */
  const tradingAddress = (vaultAddress ?? embeddedAddress) as `0x${string}`;
  // Demo mode (HL testnet) — when true, perp/spot toggle is suppressed
  // (universe restricted to vetted demo perps in index.tsx) and we render a
  // DEMO badge in its place at the card header.
  const isDemo = useIsDemo();
  const { getAccessToken } = useAuth();

  const [leverage, setLeverage] = useState(5);
  // Seed from an existing position/resting lock when the sheet remounts so we
  // don't flash default 'cross' → saved 'isolated' → locked 'cross' after a
  // quick close/reopen following a fill.
  const [marginMode, setMarginMode] = useState<'isolated' | 'cross'>(
    () => existingPosition?.marginType ?? restingOrderLock?.marginType ?? 'cross',
  );
  const [sizePct, setSizePct] = useState(0);
  const [sizePctDraft, setSizePctDraft] = useState<string | null>(null);
  const [sizeUsdText, setSizeUsdText] = useState('');
  const [sizeInputMode, setSizeInputMode] = useState<'pct' | 'usd'>('pct');
  /**
   * USD-mode source of truth. The Size (USD) TextInput can echo the previous
   * %-slider notional on Android after a preset tap ($1000 → still submits
   * 50% × leverage, e.g. $100k). Preset/manual USD writes this number
   * synchronously (and a ref) so Long/Short never uses that stale notional.
   */
  const [sizeUsdManual, setSizeUsdManual] = useState<number | null>(null);
  const sizeUsdManualRef = useRef<number | null>(null);
  const ignoreUsdTextEchoRef = useRef(false);
  // Track when size calculations are pending (for showing loading states)
  const [isSizeCalculating, startSizeTransition] = useTransition();
  
  // Sticky calculating state - stays true for at least 150ms to avoid flicker
  const [showCalculating, setShowCalculating] = useState(false);
  const calculatingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSliderChangeRef = useRef<number>(0);
  /** Last hydrated orderable USDC — avoids flashing dex-only / $0 mid-load. */
  const lastKnownOrderAvailableRef = useRef<number | null>(null);
  
  // When slider changes, immediately show calculating state
  const triggerCalculating = useCallback(() => {
    lastSliderChangeRef.current = Date.now();
    setShowCalculating(true);
    if (calculatingTimeoutRef.current) {
      clearTimeout(calculatingTimeoutRef.current);
    }
  }, []);
  
  // When React's transition ends, keep showing for minimum time
  useEffect(() => {
    if (!isSizeCalculating && showCalculating) {
      const elapsed = Date.now() - lastSliderChangeRef.current;
      const minDisplayTime = 150;
      const remaining = Math.max(0, minDisplayTime - elapsed);
      
      calculatingTimeoutRef.current = setTimeout(() => {
        setShowCalculating(false);
      }, remaining);
    }
    return () => {
      if (calculatingTimeoutRef.current) {
        clearTimeout(calculatingTimeoutRef.current);
      }
    };
  }, [isSizeCalculating, showCalculating]);
  
  const [submittingSide, setSubmittingSide] = useState<'long' | 'short' | null>(null);
  // Snapshot of the size UI at submit-start. Live available-margin props can
  // thrash mid-flight (JIT sendAsset, WS clearinghouse, spot refetch), which
  // used to make the % slider / $ size bounce even though the order already
  // captured a fixed notional. We paint from this snapshot until submit ends.
  const frozenSizeRef = useRef<{
    displaySizePct: number;
    sizeUsdText: string;
    sizeUnits: number;
    marginRequiredUsd: number;
  } | null>(null);
  // Clear the snapshot only after submittingSide has committed to null, so a
  // parent re-render can't briefly paint live thrashing values mid-submit.
  useEffect(() => {
    if (submittingSide == null) {
      frozenSizeRef.current = null;
    }
  }, [submittingSide]);
  const [tradeSide, setTradeSide] = useState<'long' | 'short'>('long');
  // Explicit "Reduce Only" intent — mirrors HL's order-entry checkbox. Only
  // meaningful when a perp position is already open: it locks intent to
  // "shrink this position" so we can give the user a clean projected liq on
  // the reducing side and a hard "Reduce Only Too Large" error when size >
  // existing notional. When off, we fall back to the implicit eligibility
  // detection (reduceOnlyEligibleLong/Short below).
  const [reduceOnly, setReduceOnly] = useState(false);
  const [showReduceOnlyInfo, setShowReduceOnlyInfo] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [tempLeverage, setTempLeverage] = useState(5);
  const [isLeveragePrefLoading, setIsLeveragePrefLoading] = useState(false);
  const tempLeverageRef = useRef(tempLeverage);
  const handleTempLeverageChange = useCallback((v: number) => {
    tempLeverageRef.current = v;
    setTempLeverage(v);
  }, []);
  const [tempMarginMode, setTempMarginMode] = useState<'isolated' | 'cross'>('cross');
  const [marketType, setMarketType] = useState<'perp' | 'spot'>('perp');
  const [showMarketTypeModal, setShowMarketTypeModal] = useState(false);
  const [transferModalOpen, setTransferModalOpen] = useState(false);
  const [transferDirection, setTransferDirection] = useState<'toPerp' | 'toSpot'>('toPerp');
  const [transferAmountText, setTransferAmountText] = useState('');
  const [isTransferring, setIsTransferring] = useState(false);
  const [balanceModalOpen, setBalanceModalOpen] = useState(false);
  const submitGuardRef = useRef(false);
  const { builderFeeRate } = useBuilderConfig();

  const { guard: sharedAiGuard, modal: sharedAiModal } = useSharedAiTradeGuard({
    symbol: coin || symbol,
    marketType,
    // Shared-mode conflict only applies on Main; Dedicated is a separate book.
    enabled: isAuthenticated && !isDedicatedBook,
  });

  // Use coin (with dex prefix like "xyz:TSLA") for HIP-3 assets to fetch correct meta
  const marginLookupKey = isHip3 ? coin : symbol;

  // The drawer can stay mounted while the parent asset changes. Clear
  // order-entry state on symbol changes so a manual HYPE size/reduce-only
  // state cannot be submitted on BTC before the UI visually catches up.
  useEffect(() => {
    submitGuardRef.current = false;
    setSubmittingSide(null);
    setSizeInputMode('pct');
    setSizePct(0);
    setSizePctDraft(null);
    setSizeUsdText('');
    setSizeUsdManual(null);
    sizeUsdManualRef.current = null;
    ignoreUsdTextEchoRef.current = false;
    setReduceOnly(false);
  }, [marginLookupKey]);

  const { data: userFees } = useQuery({
    queryKey: ['hl_user_fees', tradingAddress],
    queryFn: () => getUserFees(tradingAddress),
    enabled: !!tradingAddress,
    staleTime: 60000,
  });

  const { data: hip3FeeParams } = useQuery({
    queryKey: ['hl_hip3_fee_params', coin],
    queryFn: () => getHip3FeeParams(coin),
    enabled: !!isHip3 && !!coin && String(coin).includes(':'),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const { data: spotState, isFetched: spotStateFetched, refetch: refetchSpotState } = useQuery({
    queryKey: ['hl_spot_state', tradingAddress],
    queryFn: () => getSpotClearinghouseState(tradingAddress),
    enabled: !!tradingAddress,
    staleTime: 15000,
    // Spot balance shown in the card — keep the 30s cadence the old global
    // default provided (fills also trigger an explicit refetch).
    refetchInterval: 30_000,
  });

  const spotPair = useMemo(() => spotSymbolProp || symbol || '', [spotSymbolProp, symbol]);
  const { data: spotAssetData } = useQuery({
    queryKey: ['hl_spot_asset', tradingEnv, spotPair],
    queryFn: () => getSpotAssetData(spotPair),
    enabled: !!spotPair,
    staleTime: 15000,
    // Spot mark/mid used for sizing + min-order checks — keep 30s fresh
    // (live ticks come from the WS spot price subscription).
    refetchInterval: 30_000,
  });
  const spotAvailable = !!spotAssetData?.spotSymbol;

  const canToggleSpot = useMemo(() => {
    if (!demoAllowsSpot(tradingEnv)) return false;
    if (isSpotOnly) return true;

    const base = String(spotAssetData?.baseCoin || symbol || '').toUpperCase();
    const baseWithoutU = base.startsWith('U') && base.length > 1 ? base.slice(1) : base;

    // Only allow the toggle for curated spot symbols (mirrors the homepage
    // spot list). Keeps users on deep perp books for coins with thin spot
    // liquidity (e.g. TAO, WLD) even if Hyperliquid lists a spot market.
    return spotAvailable && (SPOT_TOGGLE_WHITELIST.has(base) || SPOT_TOGGLE_WHITELIST.has(baseWithoutU));
  }, [tradingEnv, isSpotOnly, spotAssetData?.baseCoin, spotAvailable, symbol]);

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
    }
  }, [tradingEnv, isSpotOnly, marketType]);

  // Reset to perp if asset doesn't support spot
  useEffect(() => {
    if (marketType === 'spot' && !canToggleSpot && !isSpotOnly) {
      setMarketType('perp');
    }
  }, [canToggleSpot, isSpotOnly, marketType]);
  
  const spotLivePrices = useLivePrices(spotAssetData?.spotSymbol ? [spotAssetData.spotSymbol] : []);
  const spotLivePx = useMemo(() => {
    const key = spotAssetData?.spotSymbol;
    const raw = key ? spotLivePrices?.[key]?.price : undefined;
    const v = parseFloat(String(raw ?? ''));
    return Number.isFinite(v) ? v : undefined;
  }, [spotAssetData?.spotSymbol, spotLivePrices]);

  // Subscribe to the perp mark context for THIS asset so margin/PnL-style
  // previews use HL mark price, not a raw allMids value. Keep allMids as a
  // fallback for main-dex quote responsiveness.
  const perpLiveCoins = useMemo(
    () => (coin && marketType !== 'spot' ? getPriceLookupKeys({ coin, symbol, isHip3 }) : []),
    [coin, isHip3, marketType, symbol],
  );
  const perpAssetCtxCoins = useMemo(
    () => (marketType !== 'spot' ? perpLiveCoins.slice(0, 1) : []),
    [marketType, perpLiveCoins],
  );
  const perpAssetCtxs = useLiveAssetCtxs(perpAssetCtxCoins);
  const perpLivePrices = useLivePrices(perpLiveCoins);
  const perpLivePx = useMemo(() => {
    if (!coin) return undefined;
    const ctxKey = perpAssetCtxCoins[0];
    const raw = (ctxKey ? perpAssetCtxs?.[ctxKey]?.markPx : undefined) ?? pickPrice(perpLivePrices, { coin, symbol, isHip3 });
    const v = parseFloat(String(raw ?? ''));
    return Number.isFinite(v) && v > 0 ? v : undefined;
  }, [coin, isHip3, perpAssetCtxCoins, perpAssetCtxs, perpLivePrices, symbol]);

  const { data: marginSupport } = useQuery({
    queryKey: ['hl_margin_support', marginLookupKey],
    queryFn: () => getPerpMarginSupport(marginLookupKey),
    enabled: !!marginLookupKey,
    staleTime: 5 * 60 * 1000,
  });

  // Effective cross-margin availability for THIS user on THIS asset.
  //
  // `marginSupport.supportsCross` only reflects the asset's metadata
  // (whether the asset itself allows cross). On HIP-3 dexes, several
  // assets (e.g. xyz:TSLA) have `supportsCross=true` at the asset level,
  // but HL's protocol still REJECTS cross orders on them unless the user
  // is in `unifiedAccount` or `portfolioMargin` mode — standard / default
  // users get a "switch to unified margin" prompt from HL itself.
  //
  // Without this gate, standard-mode users could pick "cross" on a HIP-3
  // asset and our preview would silently fall back to isolated math
  // (because the unified-pool inputs are zero in standard mode), making
  // the projected liq look "stuck" regardless of size — and the order
  // would be rejected by HL anyway. Disabling the cross button matches
  // both HL's UI and what the protocol actually allows.
  const effectiveSupportsCross =
    !!marginSupport?.supportsCross && canUseCrossOnAsset(!!isHip3, accountAbstractionMode);

  // HL pins margin mode per asset once a position or resting limit exists.
  // This must win over saved prefs and the default 'cross' — otherwise a
  // quick sheet remount after a fill races: default/saved → lock → flicker.
  const lockedMarginMode: 'isolated' | 'cross' | null =
    marketType === 'perp'
      ? (existingPosition?.marginType ?? restingOrderLock?.marginType ?? null)
      : null;

  // Load saved margin type when symbol or margin support changes — but never
  // overwrite an HL lock. Short delay lets a just-filled position land in
  // props before we apply a stale AsyncStorage preference.
  useEffect(() => {
    if (!marginLookupKey || !marginSupport) return;
    if (lockedMarginMode) {
      setMarginMode(lockedMarginMode);
      setTempMarginMode(lockedMarginMode);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        const saved = await getSavedMarginType(
          tradingAddress || null,
          marginLookupKey,
          effectiveSupportsCross,
        );
        if (!cancelled) {
          setMarginMode(saved);
          setTempMarginMode(saved);
        }
      })();
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    tradingAddress,
    marginLookupKey,
    marginSupport,
    effectiveSupportsCross,
    lockedMarginMode,
  ]);

  // NOTE: There used to be a `useEffect` here that unconditionally forced
  // `marginMode` to 'isolated' for every HIP-3 asset. That was correct
  // when HL only supported isolated on HIP-3 dexes, but several HIP-3
  // assets (e.g. TSLA on `xyz`) now support cross margin. The unconditional
  // override stomped on the saved-preference effect AFTER it had loaded,
  // silently flipping the user back to isolated even when they explicitly
  // chose cross — and made the size slider look broken because
  // `estimateLiqPriceIsolated` is size-independent at fixed leverage, so
  // the projected liq stayed constant regardless of order size.
  // Lock → saved-pref (delayed) → supportsCross-guard now handle this.

  const { data: marginTiers } = useQuery({
    queryKey: ['hl_margin_tiers', marginLookupKey],
    queryFn: () => getPerpMarginTiers(marginLookupKey),
    enabled: !!marginLookupKey,
    staleTime: 5 * 60 * 1000,
  });

  const maxLeverageFromTiers = useMemo(() => {
    if (!marginTiers || marginTiers.length === 0) return 0;
    return Math.max(...marginTiers.map((t: any) => Number(t.maxLeverage) || 0));
  }, [marginTiers]);
  const maxLeverageEffective = Math.max(1, maxLeverage ?? 0, maxLeverageFromTiers || 0);

  // Track if modal is open (ref avoids causing useEffect re-runs)
  const settingsModalOpenRef = useRef(showSettingsModal);
  useEffect(() => {
    settingsModalOpenRef.current = showSettingsModal;
  }, [showSettingsModal]);

  // Load saved leverage when symbol changes (NOT when modal closes - that would race with save)
  useEffect(() => {
    if (!marginLookupKey || !maxLeverageEffective) return;
    let cancelled = false;
    setIsLeveragePrefLoading(true);
    (async () => {
      console.log('[QuickTradeCard] Loading leverage for:', { marginLookupKey, tradingAddress: tradingAddress?.slice(0, 10), maxLeverageEffective });
      const saved = await getSavedLeverage(
        tradingAddress || null,
        marginLookupKey,
        maxLeverageEffective,
      );
      console.log('[QuickTradeCard] Loaded leverage:', saved);
      if (!cancelled) {
        setLeverage(saved);
        if (!settingsModalOpenRef.current) {
          setTempLeverage(saved);
          tempLeverageRef.current = saved;
        }
      }
      if (!cancelled) setIsLeveragePrefLoading(false);
    })().catch(() => {
      if (!cancelled) setIsLeveragePrefLoading(false);
    });
    return () => {
      cancelled = true;
      setIsLeveragePrefLoading(false);
    };
  }, [tradingAddress, marginLookupKey, maxLeverageEffective]);

  // Clamp leverage to max
  useEffect(() => {
    setLeverage((cur) => Math.min(Math.max(1, cur), maxLeverageEffective));
  }, [maxLeverageEffective]);

  // When there's an existing isolated position OR a resting limit order
  // for this asset, sync leverage to match it. HL applies leverage at the
  // asset level — placing a market order at a different leverage would
  // silently re-leverage every resting limit + the asset's recorded value.
  useEffect(() => {
    if (marketType !== 'perp') return;
    let lockedLev: number | undefined;
    if (marginMode === 'isolated' && existingPosition?.leverage) {
      lockedLev = Math.max(1, existingPosition.leverage);
    } else if (
      restingOrderLock?.leverage != null &&
      restingOrderLock?.marginType === marginMode
    ) {
      lockedLev = Math.max(1, restingOrderLock.leverage);
    }
    if (lockedLev && leverage !== lockedLev) {
      setLeverage(lockedLev);
      setTempLeverage(lockedLev);
      tempLeverageRef.current = lockedLev;
    }
  }, [
    existingPosition?.leverage,
    restingOrderLock?.leverage,
    restingOrderLock?.marginType,
    marginMode,
    marketType,
    leverage,
  ]);

  // Keep local state pinned while an HL lock is present (also covers the
  // case where the position arrives after mount).
  useEffect(() => {
    if (!lockedMarginMode) return;
    if (marginMode !== lockedMarginMode) {
      setMarginMode(lockedMarginMode);
      setTempMarginMode(lockedMarginMode);
    }
  }, [lockedMarginMode, marginMode]);

  // Reduce-only is only meaningful for a live perp position on this coin.
  // Auto-clear the toggle when the user switches to spot, the position is
  // closed elsewhere, or the symbol changes — otherwise a stale `true` could
  // silently disable both buttons on a fresh market.
  useEffect(() => {
    if (!existingPosition || marketType !== 'perp') {
      setReduceOnly(false);
    }
  }, [existingPosition, marketType]);

  // Switch to isolated if cross not supported — but never fight an HL lock
  // (e.g. an open cross position on a HIP-3 asset in unified mode).
  useEffect(() => {
    if (lockedMarginMode) return;
    if (marginSupport && !effectiveSupportsCross && marginMode === 'cross') {
      setMarginMode('isolated');
      setTempMarginMode('isolated');
    }
  }, [lockedMarginMode, marginMode, marginSupport, effectiveSupportsCross]);

  useEffect(() => {
    if (marketType !== 'spot') return;
    if (leverage !== 1) {
      setLeverage(1);
      setTempLeverage(1);
      tempLeverageRef.current = 1;
    }
    if (marginMode !== 'isolated') {
      setMarginMode('isolated');
      setTempMarginMode('isolated');
    }
  }, [leverage, marginMode, marketType]);

  const oraclePx = useMemo(() => {
    if (marketType === 'spot') {
      const v = parseFloat(String(spotLivePx ?? spotAssetData?.midPx ?? spotAssetData?.markPx ?? '0'));
      if (Number.isFinite(v) && v > 0) return v;
      return 0;
    }
    // Perp: prefer the WS mid; fall back to the REST oracle/mark snapshot.
    if (perpLivePx != null) return perpLivePx;
    const v = parseFloat(oraclePxProp || markPx || '0');
    return Number.isFinite(v) ? v : 0;
  }, [markPx, marketType, oraclePxProp, perpLivePx, spotAssetData?.markPx, spotAssetData?.midPx, spotLivePx]);

  const markPxNum = useMemo(() => {
    if (marketType === 'spot') {
      const v = parseFloat(String(spotLivePx ?? spotAssetData?.midPx ?? spotAssetData?.markPx ?? '0'));
      if (Number.isFinite(v) && v > 0) return v;
      return NaN;
    }
    // Perp: prefer the WS mid; fall back to the REST mark snapshot.
    if (perpLivePx != null) return perpLivePx;
    const v = parseFloat(markPx || '0');
    return Number.isFinite(v) ? v : NaN;
  }, [markPx, marketType, perpLivePx, spotAssetData?.markPx, spotAssetData?.midPx, spotLivePx]);

  const formatPreviewPrice = useCallback((n: number) => {
    if (!Number.isFinite(n)) return '--';
    const abs = Math.abs(n);
    if (abs >= 1000) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (abs >= 100) return n.toFixed(2);
    if (abs >= 10) return n.toFixed(3);
    if (abs >= 1) return n.toFixed(3);
    if (abs >= 0.1) return n.toFixed(4);
    return n.toFixed(6);
  }, []);

  // Protocol fees: userFees base × HIP-3 deployerFeeScale × growthMode (HL formula).
  // Builder fee is added separately below. Live meta is preferred over asset props.
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
    hip3FeeParams?.deployerFeeScale ?? parseDeployerFeeScale(deployerFeeScale, 1);
  const resolvedGrowthMode = hip3FeeParams?.growthMode ?? !!growthMode;

  const protocolFees = computeProtocolFeeRates({
    takerRate: baseTakerFeeRate,
    makerRate: baseMakerFeeRate,
    activeReferralDiscount: referralDiscount,
    kind: marketType === 'spot' ? 'spot' : 'perp',
    isHip3: !!isHip3 && marketType === 'perp',
    deployerFeeScale: resolvedDeployerFeeScale,
    growthMode: resolvedGrowthMode,
  });
  // QuickTrade is market-only → always taker protocol fee.
  const protocolFeeRate = protocolFees.takerRate;
  const isHlPooledAccount = isPooledAccountMode(accountAbstractionMode);
  const dexKeyForOrder = String(coin ?? '').includes(':') ? String(coin).split(':')[0] : '';
  const transferablePerpUsd = useMemo(() => {
    if (marketType !== 'perp') return 0;
    const byDex = perpWithdrawableByDex ?? {};
    return Object.entries(byDex).reduce((sum, [dex, value]) => {
      if (dex === dexKeyForOrder) return sum;
      const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
      return sum + (Number.isFinite(n) && n > 0 ? n : 0);
    }, 0);
  }, [dexKeyForOrder, marketType, perpWithdrawableByDex]);
  const mainDexTransferAvailableUsd = Number.isFinite(mainDexWithdrawableUsd ?? NaN)
    ? Math.max(0, mainDexWithdrawableUsd as number)
    : 0;
  // Spot → perp transferable budget. Single source of truth in
  // `computeUnifiedSpotTransferableUsd` (HL's documented `max(initial,
  // 0.10 × position_value)` rule) so slider Max, preflight, and JIT
  // funding all agree on what HL will actually accept.
  const unifiedSpotTransferableUsd = useMemo(() => {
    if (!isHlPooledAccount) return 0;
    return computeUnifiedSpotTransferableUsd({
      spotUsdcBalanceUsd: unifiedSpotUsdcBalanceUsd ?? 0,
      totalCrossInitialMarginUsedUsd: unifiedTotalCrossInitialMarginUsedUsd ?? 0,
      totalCrossPositionValueUsd: unifiedTotalCrossPositionValueUsd ?? 0,
      totalIsolatedMarginUsedUsd: unifiedTotalIsolatedMarginUsedUsd ?? 0,
      spotUsdcHoldUsd: unifiedSpotUsdcHoldUsd ?? 0,
      restingOrdersInitMarginUsd: unifiedRestingOrdersInitMarginUsd ?? 0,
    });
  }, [
    isHlPooledAccount,
    unifiedSpotUsdcBalanceUsd,
    unifiedSpotUsdcHoldUsd,
    unifiedTotalCrossInitialMarginUsedUsd,
    unifiedTotalCrossPositionValueUsd,
    unifiedTotalIsolatedMarginUsedUsd,
    unifiedRestingOrdersInitMarginUsd,
  ]);
  const isHip3Order = marketType === 'perp' && !!dexKeyForOrder;
  const hlPerpOrderAvailableUsdRaw = (() => {
    if (marketType !== 'perp') return withdrawableUsd;
    if (!isHlPooledAccount) {
      // Standard mode: per-dex pool + transferables from other dexes via
      // perp-to-perp `sendAsset`.
      return Number.isFinite(targetDexMarginAvailableUsd ?? NaN)
        ? Math.max(0, targetDexMarginAvailableUsd as number) + transferablePerpUsd
        : withdrawableUsd;
    }
    // Unified mode:
    //   • Main perp orders use the unified pool directly (no transfer needed),
    //     so `withdrawableUsd` (= pooledMarginAvailable) is the ceiling.
    //   • HIP-3 orders MUST be funded via `sendAsset(spot → <dex>)`. The
    //     real ceiling is the strict spot-transferable budget plus whatever
    //     the target dex already holds.
    if (isHip3Order) {
      const targetDexBalance = Number.isFinite(targetDexMarginAvailableUsd ?? NaN)
        ? Math.max(0, targetDexMarginAvailableUsd as number)
        : 0;
      return unifiedSpotTransferableUsd + targetDexBalance;
    }
    return withdrawableUsd;
  })();
  // Prefer waiting over flashing HIP-3 dex leftover (~$2 on xyz) or $0 while
  // abstraction mode / spot USDC are still hydrating.
  const spotBalancesHydrated = !tradingAddress || spotStateFetched;
  const orderAvailableHydrated = isOrderAvailableHydrated({
    accountAbstractionMode,
    isHip3Order,
    spotBalancesHydrated,
  });
  if (orderAvailableHydrated && Number.isFinite(hlPerpOrderAvailableUsdRaw)) {
    lastKnownOrderAvailableRef.current = Math.max(0, hlPerpOrderAvailableUsdRaw);
  }
  const showOrderAvailableAmount =
    orderAvailableHydrated || lastKnownOrderAvailableRef.current != null;
  const hlPerpOrderAvailableUsd = orderAvailableHydrated
    ? hlPerpOrderAvailableUsdRaw
    : (lastKnownOrderAvailableRef.current ?? 0);
  const availableUsd = hlPerpOrderAvailableUsd;

  const spotBalances = useMemo(() => {
    const balances = spotState?.balances ?? spotState?.spotState?.balances ?? [];
    const usdc = balances.find((b: any) => String(b?.coin ?? '').toUpperCase() === 'USDC');
    const total = parseFloat(usdc?.total ?? '0');
    const hold = parseFloat(usdc?.hold ?? '0');
    const available = Math.max(0, (Number.isFinite(total) ? total : 0) - (Number.isFinite(hold) ? hold : 0));
    return {
      total: Number.isFinite(total) ? total : null,
      hold: Number.isFinite(hold) ? hold : null,
      available,
      hasData: !!usdc,
    };
  }, [spotState]);

  const spotBaseAvailable = useMemo(() => {
    const base = (spotAssetData?.baseCoin || symbol || '').toUpperCase();
    const balances = spotState?.balances ?? spotState?.spotState?.balances ?? [];
    const baseBal = balances.find((b: any) => String(b?.coin ?? '').toUpperCase() === base);
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
  }, [spotAssetData?.baseCoin, spotAssetData?.szDecimals, spotState, symbol]);

  const availableUsdLong = marketType === 'spot'
    ? (isHlPooledAccount
      ? Math.max(spotBalances.available, Math.max(0, withdrawableUsd - (unifiedSpotUsdcHoldUsd ?? 0)))
      : spotBalances.available)
    : availableUsd;
  const availableUsdShort =
    marketType === 'spot' ? spotBaseAvailable.available * Math.max(0, oraclePx) : availableUsd;
  const canSellSpot = marketType !== 'spot' || spotBaseAvailable.available > 0;
  const spotBaseUsd = useMemo(() => {
    const v = spotBaseAvailable.available * Math.max(0, oraclePx);
    return Number.isFinite(v) ? v : 0;
  }, [oraclePx, spotBaseAvailable.available]);
  const spotTotalUsd = useMemo(() => {
    const usdcBal = spotBalances.available;
    const v = usdcBal + spotBaseUsd;
    return Number.isFinite(v) ? v : 0;
  }, [spotBalances.available, spotBaseUsd]);
  const spotBreakdownText = useMemo(() => {
    if (!spotBalances.hasData && !spotBaseAvailable.hasData) return '--';
    const usdc = spotBalances.available.toFixed(2);
    const base = spotBaseAvailable.available.toFixed(4);
    const baseLabel = symbol?.toUpperCase() || 'BASE';
    return `$${usdc} usdc - ${base} ${baseLabel}`;
  }, [spotBalances.available, spotBalances.hasData, spotBaseAvailable.available, spotBaseAvailable.hasData, symbol]);

  // Fee rates (defined early so maxUsableMarginUsd can use them)
  const spotBuilderFeeRate = getSpotBuilderFeeTenthsBps() * 0.00001;
  const builderFeeRateEffective = marketType === 'spot' ? spotBuilderFeeRate : builderFeeRate;

  // Max usable margin. HL's order-acceptance check is purely
  //   `accountValue ≥ initialMargin`
  // regardless of abstraction mode (per HL margining docs — maintenance
  // margin is a *liquidation*-time concept, not an order-time one). So the
  // sizing constraint is just:
  //   N/L (init) + N × feeRate (fees deducted at fill) ≤ available
  //   maxMargin = N/L = available / (1 + L × feeRate)
  // We previously also reserved a maintenance fraction and multiplied
  // feeRate by L for unified-mode cross orders. That over-reserved by a
  // factor of L on the fee term (fees scale with notional, not with
  // leverage²) and added a maint reservation HL doesn't actually require
  // at order time. The result was that $19 spot at 40x BTC capped notional
  // at ~$280 instead of ~$740.
  const maxUsableMarginUsd = useMemo(() => {
    const BUFFER_FACTOR = 0.995;
    const totalFeeRate = protocolFeeRate + builderFeeRateEffective;
    if (marketType === 'spot') {
      if (tradeSide === 'short') {
        return Math.max(0, availableUsdShort);
      }
      const denom = 1 + totalFeeRate;
      return Math.max(0, (availableUsdLong / denom) * BUFFER_FACTOR);
    }
    const a = Math.max(0, availableUsd);
    const L = Math.max(1, leverage);
    const denom = 1 + totalFeeRate * L;
    if (denom <= 0) return 0;
    return Math.max(0, (a / denom) * BUFFER_FACTOR);
  }, [
    availableUsd,
    availableUsdLong,
    availableUsdShort,
    builderFeeRateEffective,
    leverage,
    marketType,
    protocolFeeRate,
    tradeSide,
  ]);

  // Calculate size USD from percentage or manual input
  const sizeUsd = useMemo(() => {
    if (sizeInputMode === 'usd') {
      if (sizeUsdManual != null && Number.isFinite(sizeUsdManual) && sizeUsdManual > 0) {
        return sizeUsdManual;
      }
      const parsed = parseUsdNotional(sizeUsdText);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    if (!Number.isFinite(maxUsableMarginUsd) || maxUsableMarginUsd <= 0) return 0;
    const pct = Math.max(0, Math.min(100, sizePct));
    const basis = maxUsableMarginUsd * (pct / 100);
    return marketType === 'spot' ? basis : basis * Math.max(1, leverage);
  }, [leverage, marketType, maxUsableMarginUsd, sizePct, sizeInputMode, sizeUsdManual, sizeUsdText]);

  useEffect(() => {
    // Don't let live margin churn rewrite sizePct while an order is in flight —
    // that would leave a corrupted % when submit unfreezes.
    if (submittingSide) return;
    if (sizeInputMode !== 'usd') return;
    if (!Number.isFinite(maxUsableMarginUsd) || maxUsableMarginUsd <= 0) return;
    if (!Number.isFinite(sizeUsd) || sizeUsd <= 0) return;
    const basis = marketType === 'spot' ? sizeUsd : sizeUsd / Math.max(1, leverage);
    const pct = (basis / maxUsableMarginUsd) * 100;
    setSizePct(clampSizePct(pct));
  }, [leverage, marketType, maxUsableMarginUsd, sizeInputMode, sizeUsd, submittingSide]);

  useEffect(() => {
    if (marketType !== 'spot') return;
  }, [marketType, oraclePx, sizeUsd, spotAssetData?.markPx, spotAssetData?.midPx, spotAssetData?.spotSymbol, symbol]);

  // Sync USD text when in pct mode (also clear when sizeUsd is 0, e.g. switching buy→sell)
  useEffect(() => {
    // Skip while submitting — UI reads from frozenSizeRef instead, and writing
    // here would fight the freeze with thrashing live sizeUsd values.
    if (submittingSide) return;
    // Skip while leverage prefs are still loading — otherwise remount after a
    // fill flashes $ size as leverage jumps 5 → saved (e.g. 20).
    if (isLeveragePrefLoading) return;
    if (sizeInputMode === 'pct') {
      setSizeUsdText(sizeUsd > 0 ? sizeUsd.toFixed(2) : '');
    }
  }, [sizeInputMode, sizeUsd, submittingSide, isLeveragePrefLoading]);

  // Handle manual USD input
  const handleSizeUsdChange = useCallback((text: string) => {
    if (submittingSide) return;
    if (ignoreUsdTextEchoRef.current) {
      const parsed = parseUsdNotional(text);
      const locked = sizeUsdManualRef.current;
      if (locked != null && !(Number.isFinite(parsed) && Math.abs(parsed - locked) < 0.51)) {
        return;
      }
      ignoreUsdTextEchoRef.current = false;
      if (locked != null && Number.isFinite(parsed) && Math.abs(parsed - locked) < 0.51) {
        return;
      }
    }
    setSizeInputMode('usd');
    setSizeUsdText(text);
    const parsed = parseUsdNotional(text);
    const next = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    sizeUsdManualRef.current = next;
    setSizeUsdManual(next);
  }, [submittingSide]);

  const handleSizePctChange = useCallback((pct: number) => {
    if (submittingSide) return;
    triggerCalculating();
    sizeUsdManualRef.current = null;
    ignoreUsdTextEchoRef.current = false;
    startSizeTransition(() => {
      setSizeUsdManual(null);
      setSizeInputMode('pct');
      setSizePct(pct);
    });
  }, [startSizeTransition, submittingSide, triggerCalculating]);

  // Format percentage for display
  const formatSizePct = useCallback((v: number) => `${formatSizePctNumber(v)}%`, []);

  const sizeUnits = useMemo(() => {
    if (!sizeUsd || !oraclePx) return 0;
    return sizeUsd / oraclePx;
  }, [sizeUsd, oraclePx]);

  const spotMinNotionalUsd = 10;
  const spotSlippageBps = 50;
  const spotMinSizeUnits = marketType === 'spot' ? Math.pow(10, -(spotAssetData?.szDecimals ?? 0)) : 0;
  const spotRefPx = marketType === 'spot' ? Math.max(0, oraclePx) : 0;
  const spotSizePow = Math.pow(10, spotAssetData?.szDecimals ?? 0);
  const spotSizeUnitsRaw = spotRefPx > 0 ? sizeUsd / spotRefPx : 0;
  const spotSizeUnitsRounded = spotSizePow > 0 ? Math.floor(spotSizeUnitsRaw * spotSizePow) / spotSizePow : 0;
  const spotPxForCheck = spotRefPx > 0 ? spotRefPx * (1 - spotSlippageBps / 10000) : 0;
  const spotNotionalRounded = spotSizeUnitsRounded * spotPxForCheck;
  const spotMinUsdRequired = useMemo(() => {
    if (marketType !== 'spot' || spotMinSizeUnits <= 0 || spotPxForCheck <= 0) return spotMinNotionalUsd;
    const minUnitsForNotional =
      Math.ceil(spotMinNotionalUsd / spotPxForCheck / spotMinSizeUnits) * spotMinSizeUnits;
    const v = minUnitsForNotional * spotPxForCheck;
    return Number.isFinite(v) ? v : spotMinNotionalUsd;
  }, [marketType, spotMinNotionalUsd, spotMinSizeUnits, spotPxForCheck]);
  // HL spot orders: enforce min notional / lot sizing
  const belowSpotMin =
    marketType === 'spot' &&
    sizeUsd > 0 &&
    (sizeUsd + 1e-9 < spotMinUsdRequired || spotSizeUnitsRounded < spotMinSizeUnits);
  const estFeeUsd = sizeUsd > 0 ? sizeUsd * (protocolFeeRate + builderFeeRateEffective) : 0;
  const marginRequiredUsd = marketType === 'spot' ? sizeUsd : leverage > 0 ? sizeUsd / leverage : 0;
  const notEnoughMarginLong =
    marketType === 'spot'
      // Spot BUY: USDC budget must cover order notional + fee.
      ? sizeUsd + estFeeUsd > availableUsdLong + 1e-9
      : marginRequiredUsd + estFeeUsd > availableUsd + 1e-9;
  // Spot SELL: compare BASE units, not USD. When the slider is at 100%
  // both `sizeUsd` and `availableUsdShort` are `baseAvailable × oraclePx`,
  // but only the latter re-evaluates on every live price tick; the former
  // snaps to a `.toFixed(2)` rounded string and updates on the next %→$
  // effect cycle. That lag is what flipped the Max-sell button between
  // enabled and "margin insufficient" mid-session. Base-unit comparison
  // scales with price on BOTH sides so normal mid drift can't move one
  // relative to the other. Tolerance is the asset's min lot.
  const spotSellBaseTolerance =
    marketType === 'spot' && tradeSide === 'short'
      ? Math.max(Math.pow(10, -(spotAssetData?.szDecimals ?? 2)), 1e-9)
      : 1e-9;
  const notEnoughMarginShort =
    marketType === 'spot'
      ? sizeUnits > spotBaseAvailable.available + spotSellBaseTolerance
      : marginRequiredUsd + estFeeUsd > availableUsd + 1e-9;
  const existingNotional = useMemo(() => {
    if (!existingPosition || !Number.isFinite(oraclePx) || oraclePx <= 0) return 0;
    return Math.abs(existingPosition.sizeUnits) * oraclePx;
  }, [existingPosition, oraclePx]);
  const reduceOnlyEligibleLong =
    marketType !== 'spot' &&
    existingNotional > 0 &&
    existingPosition?.side === 'short' &&
    Number.isFinite(sizeUsd) &&
    sizeUsd > 0 &&
    sizeUsd <= existingNotional + 1e-9;
  const reduceOnlyEligibleShort =
    marketType !== 'spot' &&
    existingNotional > 0 &&
    existingPosition?.side === 'long' &&
    Number.isFinite(sizeUsd) &&
    sizeUsd > 0 &&
    sizeUsd <= existingNotional + 1e-9;

  // ── Explicit Reduce-Only derivations ────────────────────────────────
  // `roAvailable`: whether it even makes sense to show the checkbox.
  // `roReducingSide`: the side that *shrinks* the open position (opposite
  //   of existing). The other side would add, which reduce-only forbids.
  // `roTooLarge`: user has RO on but the current size would overshoot the
  //   position — HL's "Reduce Only Too Large" condition.
  const roAvailable = marketType === 'perp' && !!existingPosition;
  const roReducingSide: 'long' | 'short' | null =
    existingPosition?.side === 'long' ? 'short'
    : existingPosition?.side === 'short' ? 'long'
    : null;
  const roTooLarge =
    reduceOnly && existingNotional > 0 && sizeUsd > existingNotional + 1e-9;
  // Each side is blocked by RO when: (a) RO is on AND it's the adding side,
  // or (b) RO is on AND size overshoots the position.
  const roDisablesLong = reduceOnly && (existingPosition?.side === 'long' || roTooLarge);
  const roDisablesShort = reduceOnly && (existingPosition?.side === 'short' || roTooLarge);

  const maxSizeUsdForPresets = useMemo(() => {
    const lev = Math.max(1, leverage);
    let max =
      marketType === 'spot'
        ? tradeSide === 'short'
          ? availableUsdShort
          : maxUsableMarginUsd
        : maxUsableMarginUsd * lev;
    if (reduceOnly && existingNotional > 0) {
      max = Math.min(max, existingNotional);
    }
    return Math.max(0, Number.isFinite(max) ? max : 0);
  }, [
    availableUsdShort,
    existingNotional,
    leverage,
    marketType,
    maxUsableMarginUsd,
    reduceOnly,
    tradeSide,
  ]);

  const handleSizeUsdPreset = useCallback(
    (usd: number) => {
      if (submittingSide) return;
      if (!(usd > 0) || usd > maxSizeUsdForPresets + 1e-9) return;
      triggerCalculating();
      void Haptics.selectionAsync();
      // Write the notional before React re-renders so a Long/Short tap in
      // the next gesture cannot still submit the previous %-slider size.
      sizeUsdManualRef.current = usd;
      ignoreUsdTextEchoRef.current = true;
      setSizeUsdManual(usd);
      setSizeInputMode('usd');
      setSizeUsdText(usd.toFixed(2));
    },
    [maxSizeUsdForPresets, submittingSide, triggerCalculating],
  );

  // After a fill (or leverage/margin drop), keep a tapped preset selected
  // while it's still affordable. If it isn't, clamp the USD notional — never
  // flip back to the %-slider (that restored 50% × leverage, e.g. $100k).
  const prevMaxSizeUsdForPresetsRef = useRef(maxSizeUsdForPresets);
  useEffect(() => {
    const prevMax = prevMaxSizeUsdForPresetsRef.current;
    prevMaxSizeUsdForPresetsRef.current = maxSizeUsdForPresets;
    if (submittingSide) return;
    if (sizeInputMode !== 'usd') return;
    if (!(maxSizeUsdForPresets < prevMax - 1e-9)) return;
    const matched = SIZE_USD_PRESETS.some((p) => Math.abs(sizeUsd - p.usd) < 0.51);
    if (!matched) return;
    if (sizeUsd <= maxSizeUsdForPresets + 1e-9) return;
    const clamped = Math.max(0, maxSizeUsdForPresets);
    sizeUsdManualRef.current = clamped > 0.01 ? clamped : null;
    setSizeUsdManual(clamped > 0.01 ? clamped : null);
    setSizeUsdText(clamped > 0.01 ? clamped.toFixed(2) : '');
  }, [maxSizeUsdForPresets, sizeInputMode, sizeUsd, submittingSide]);

  // "Zero budget" check — fires even when the user hasn't typed a size yet.
  // Catches the unified-mode 10%-rule case where transferable spot collapses
  // to $0 (i.e. an existing cross position pins the whole pool). Without
  // this, the slider/Max collapses to 0 but the buttons still look pressable
  // until the user types a size, which is confusing.
  const PERP_MIN_USABLE_USD = 1;
  const noPerpBudget =
    marketType === 'perp' &&
    showOrderAvailableAmount &&
    Number.isFinite(availableUsd) &&
    availableUsd < PERP_MIN_USABLE_USD;
  const noSpotBuyBudget =
    marketType === 'spot' &&
    Number.isFinite(availableUsdLong) &&
    availableUsdLong < spotMinUsdRequired;
  const noSpotSellBudget =
    marketType === 'spot' &&
    Number.isFinite(availableUsdShort) &&
    availableUsdShort < spotMinUsdRequired;
  const notEnoughMarginLongEffective =
    (notEnoughMarginLong && !reduceOnlyEligibleLong) ||
    (noPerpBudget && !reduceOnlyEligibleLong) ||
    (noSpotBuyBudget && tradeSide === 'long');
  const notEnoughMarginShortEffective =
    (notEnoughMarginShort && !reduceOnlyEligibleShort) ||
    (noPerpBudget && !reduceOnlyEligibleShort) ||
    (noSpotSellBudget && tradeSide === 'short');
  const notEnoughMarginEffective = notEnoughMarginLongEffective && notEnoughMarginShortEffective;
  const spotInvalidSize = marketType === 'spot' && belowSpotMin;
  const noSizeSet = !(sizeUsd > 0);

  const displaySizePct = useMemo(() => {
    // % mode: sizePct is the source of truth. Never snap the thumb to 0 just
    // because available balance briefly flickers (spot refetch / side flip /
    // WS lag) — that was the left-right slider glitch.
    if (sizeInputMode === 'pct') {
      return clampSizePct(sizePct);
    }
    if (marketType === 'spot') {
      const basis = tradeSide === 'long' ? availableUsdLong : availableUsdShort;
      if (!Number.isFinite(basis) || basis <= 0) return 0;
      const denom = Math.max(0.01, basis);
      return clampSizePct((sizeUsd / denom) * 100);
    }
    // Perp: match trade-page behavior — always compute % against max usable
    // margin × leverage. Using existingNotional when a reduce-only trade is
    // merely *possible* gave misleading %s when the user was adding to a
    // same-side position (e.g. $600 showed 24% instead of ~5%).
    const denom = maxUsableMarginUsd * Math.max(1, leverage);
    if (!Number.isFinite(denom) || denom <= 0) return 0;
    return clampSizePct((sizeUsd / denom) * 100);
  }, [
    availableUsdLong,
    availableUsdShort,
    leverage,
    marketType,
    maxUsableMarginUsd,
    tradeSide,
    sizeInputMode,
    sizePct,
    sizeUsd,
  ]);

  // While an order is submitting, paint the size UI from the snapshot taken
  // at click — not from live margin-derived values.
  const sizeSnap = submittingSide != null ? frozenSizeRef.current : null;
  const uiDisplaySizePct = sizeSnap?.displaySizePct ?? displaySizePct;
  const uiSizeUsdText = sizeSnap?.sizeUsdText ?? sizeUsdText;
  const uiSizeUnits = sizeSnap?.sizeUnits ?? sizeUnits;
  const uiMarginRequiredUsd = sizeSnap?.marginRequiredUsd ?? marginRequiredUsd;
  const isSizeInputLocked = submittingSide != null;

  // Estimate liquidation price (for both long and short), accounting for existing position
  // Spot orders have no liquidation, so only compute for perp

  const { estLiqLong, estLiqShort } = useMemo(() => {
    if (!oraclePx || !sizeUnits || sizeUnits <= 0) {
      return { estLiqLong: null, estLiqShort: null };
    }

    // HL path: use maintenance margin tiers
    if (!marginTiers?.length) {
      return { estLiqLong: null, estLiqShort: null };
    }

    const schedule = buildMaintenanceSchedule(marginTiers);
    if (!schedule) return { estLiqLong: null, estLiqShort: null };

    const computeCombined = (orderSide: 'long' | 'short') => {
      const existing = existingPosition;
      const existingSzi = existing
        ? (existing.side === 'long' ? 1 : -1) * Math.abs(existing.sizeUnits)
        : 0;
      const orderSzi = (orderSide === 'long' ? 1 : -1) * sizeUnits;
      const combinedSzi = existingSzi + orderSzi;
      const combinedAbsSzi = Math.abs(combinedSzi);
      if (combinedAbsSzi <= 0) return null;

      const combinedSide: 'long' | 'short' = combinedSzi >= 0 ? 'long' : 'short';

      // Previously we short-circuited to null when the order opposes the
      // existing position without flipping it ("you're just reducing, no
      // liq for this side"). That's misleading: the *remaining* position
      // still has a liquidation price, and showing "N/A" makes the Reduce
      // Only preview useless. The combined calc below already produces
      // the correct liq for the shrunken position (same entry, smaller
      // size, proportional margin in isolated / unchanged in cross), so
      // we let it run in all cases and only bail when there's nothing
      // left (combinedAbsSzi === 0, handled above).

      let combinedEntryPx = oraclePx;
      if (existingSzi === 0) {
        combinedEntryPx = oraclePx;
      } else if (orderSzi === 0) {
        combinedEntryPx = existing?.entryPx ?? oraclePx;
      } else if (Math.sign(existingSzi) === Math.sign(orderSzi)) {
        combinedEntryPx =
          (Math.abs(existingSzi) * (existing?.entryPx ?? oraclePx) + Math.abs(orderSzi) * oraclePx) /
          Math.max(1e-9, combinedAbsSzi);
      } else if (Math.abs(orderSzi) < Math.abs(existingSzi)) {
        combinedEntryPx = existing?.entryPx ?? oraclePx;
      } else if (Math.abs(orderSzi) > Math.abs(existingSzi)) {
        combinedEntryPx = oraclePx;
      }

      const existingNotional = Math.abs(existingSzi) * (existing?.entryPx ?? oraclePx);
      const existingLev = Math.max(1, existing?.leverage ?? leverage);
      const existingMargin =
        Number.isFinite(existing?.marginUsedUsd ?? NaN) && (existing?.marginUsedUsd ?? 0) > 0
          ? (existing?.marginUsedUsd ?? 0)
          : existingNotional / existingLev;

      const orderNotional = Math.abs(orderSzi) * oraclePx;
      let totalInitialMargin = 0;
      if (existingSzi === 0) {
        totalInitialMargin = orderNotional / leverage;
      } else if (Math.sign(existingSzi) === Math.sign(orderSzi)) {
        totalInitialMargin = existingMargin + orderNotional / leverage;
      } else if (Math.abs(orderSzi) < Math.abs(existingSzi)) {
        const remainingRatio =
          (Math.abs(existingSzi) - Math.abs(orderSzi)) / Math.max(1e-9, Math.abs(existingSzi));
        totalInitialMargin = existingMargin * remainingRatio;
      } else if (Math.abs(orderSzi) === Math.abs(existingSzi)) {
        totalInitialMargin = 0;
      } else {
        const remainingUnits = Math.abs(orderSzi) - Math.abs(existingSzi);
        totalInitialMargin = (remainingUnits * oraclePx) / leverage;
      }

      const combinedNotional = combinedAbsSzi * combinedEntryPx;
      const effectiveLev =
        totalInitialMargin > 0 ? Math.max(1, combinedNotional / totalInitialMargin) : leverage;

      return {
        entryPx: combinedEntryPx,
        side: combinedSide,
        sizeUnits: combinedAbsSzi,
        effectiveLev,
      };
    };

    const comboLong = computeCombined('long');
    const comboShort = computeCombined('short');

    // Cross-margin pool inputs.
    //
    // Two pool models depending on HL account abstraction mode (per
    // https://hyperliquid.gitbook.io/hyperliquid-docs/trading/account-abstraction-modes):
    //
    //   • `unifiedAccount` / `portfolioMargin` (DEFAULT for app.hyperliquid.xyz)
    //     — All USDC-backed cross dexes share ONE pool. Per-dex
    //     `crossMarginSummary.accountValue` is meaningless here. The truth is:
    //
    //       margin_available = spotUsdcBalance
    //                        − Σ isolatedMarginUsed   (all dexes)
    //                        − Σ crossMaintenanceMarginUsed (all dexes,
    //                            with this asset's existing maint
    //                            replaced by the post-fill combined
    //                            position's maint inside pool mode)
    //
    //   • `disabled` / `default` / `dexAbstraction` — Standard mode.
    //     Cross is per-dex (the previous behaviour).
    //
    // Without unified-mode handling, projecting a NEW cross position on a
    // HIP-3 dex (e.g. TSLA on `xyz`) where no same-dex cross exists yet
    // sees `crossAccountValueUsd ≈ 0`, fails the canCrossProject guard,
    // falls through to isolated math, and shows a wildly wrong liq
    // (e.g. estimate 373 vs real fill 900+).
    const isUnifiedMode = isPooledAccountMode(accountAbstractionMode);
    const projectedDexFunding = (() => {
      if (isUnifiedMode || marketType !== 'perp') return 0;
      if (!Number.isFinite(sizeUsd) || sizeUsd <= 0 || !Number.isFinite(leverage) || leverage <= 0) return 0;
      if (!Number.isFinite(targetDexMarginAvailableUsd ?? NaN)) return 0;
      if (!Number.isFinite(transferablePerpUsd) || transferablePerpUsd <= 0) return 0;
      const selectedReduceOnly =
        (tradeSide === 'long' && reduceOnlyEligibleLong) ||
        (tradeSide === 'short' && reduceOnlyEligibleShort) ||
        reduceOnly;
      if (selectedReduceOnly) return 0;
      const requiredMarginWithBuffer = (sizeUsd / Math.max(1, leverage)) * 1.05;
      const shortfall = requiredMarginWithBuffer - Math.max(0, targetDexMarginAvailableUsd as number);
      return Math.max(0, Math.min(shortfall, transferablePerpUsd));
    })();

    const effectiveCrossEquity = isUnifiedMode
      ? Math.max(
          0,
          (unifiedSpotUsdcBalanceUsd ?? 0) - (unifiedTotalIsolatedMarginUsedUsd ?? 0),
        )
      : Math.max(0, crossAccountValueUsd + projectedDexFunding);
    const effectiveCrossMaintUsed = isUnifiedMode
      ? (unifiedTotalCrossMaintenanceMarginUsedUsd ?? 0)
      : crossMaintenanceMarginUsedUsd;

    // Existing same-asset cross position metadata. Used by
    // `estimateLiqPriceCross` so the Δ maint computation correctly
    // replaces the existing position's contribution to
    // `crossMaintenanceMarginUsed` with the post-fill combined position's.
    // Also serves as the back-solve anchor when the pool's
    // `crossMaintenanceMarginUsed` isn't available.
    const existingCrossAnchor =
      existingPosition &&
      existingPosition.marginType === 'cross' &&
      existingPosition.sizeUnits > 0
        ? {
            side: existingPosition.side,
            sizeUnits: existingPosition.sizeUnits,
            liquidationPx: Number.isFinite(existingPosition.liquidationPx ?? NaN)
              ? (existingPosition.liquidationPx as number)
              : 0,
            markPx: Number.isFinite(existingPosition.markPx ?? NaN)
              ? existingPosition.markPx
              : undefined,
          }
        : undefined;

    const hasPoolData =
      Number.isFinite(effectiveCrossMaintUsed) && effectiveCrossEquity > 0;
    const canCrossProject = existingCrossAnchor || hasPoolData || effectiveCrossEquity > 0;

    const liqLong =
      comboLong
        ? marginMode === 'cross'
          ? canCrossProject
            ? estimateLiqPriceCross({
                markPx: oraclePx,
                side: comboLong.side,
                sizeUnits: comboLong.sizeUnits,
                existing: existingCrossAnchor,
                accountValueUsd: effectiveCrossEquity,
                crossMaintenanceMarginUsedUsd: hasPoolData
                  ? effectiveCrossMaintUsed
                  : undefined,
                schedule,
              })
            : null
          : estimateLiqPriceIsolated({
              entryPx: comboLong.entryPx,
              side: comboLong.side,
              sizeUnits: comboLong.sizeUnits,
              leverage: comboLong.effectiveLev,
              schedule,
            })
        : null;

    const liqShort =
      comboShort
        ? marginMode === 'cross'
          ? canCrossProject
            ? estimateLiqPriceCross({
                markPx: oraclePx,
                side: comboShort.side,
                sizeUnits: comboShort.sizeUnits,
                existing: existingCrossAnchor,
                accountValueUsd: effectiveCrossEquity,
                crossMaintenanceMarginUsedUsd: hasPoolData
                  ? effectiveCrossMaintUsed
                  : undefined,
                schedule,
              })
            : null
          : estimateLiqPriceIsolated({
              entryPx: comboShort.entryPx,
              side: comboShort.side,
              sizeUnits: comboShort.sizeUnits,
              leverage: comboShort.effectiveLev,
              schedule,
            })
        : null;

    // QuickTradeCard shows projected post-fill liq for *each side*, matching
    // what HL's own web UI does in its order entry panel. For the side that
    // matches your existing position it's the compound-position liq; for the
    // opposite side it's the reduce / flip liq. We do NOT short-circuit to
    // exchange.liquidationPx here — HL has no server-side projected-liq API
    // (their UI computes it client-side too, with the same formula we use in
    // hlMargin.ts). So Portfolio = "current actual", QuickTradeCard = "where
    // your liq would move to if this order fills" — two different answers to
    // two different questions, both correct.
    //
    // Reduce-Only overlay + slot remap.
    //
    // The preview's two columns carry two different meanings depending on
    // what the user is about to do:
    //
    //   • Adding to / flipping past an existing position → the resulting
    //     position is on the order side, so "Liq Long/Short" honestly
    //     describes it. Keep as-is.
    //   • Reducing an existing position without flipping it → the resulting
    //     position is on the *existing* side, so a value under the order-
    //     side label would be lying ("Liq Short: $6539" while no short
    //     will exist). We blank that slot. Whether the user enabled the
    //     Reduce Only checkbox or not, the math is identical — it just
    //     changes whether we *also* move the reduced-position liq into
    //     the correct (existing-side) slot for emphasis.
    //
    // Matrix:
    //   RO off, order reduces  → keep adding-side liq, null the order-side
    //                             slot (its value is misleading).
    //   RO on,  order reduces  → move reduced liq to existing-side slot,
    //                             null the other (adding is forbidden).
    //   RO on,  too large      → null both (no order side is valid).
    let finalLong = liqLong;
    let finalShort = liqShort;
    if (reduceOnly && roTooLarge) {
      finalLong = null;
      finalShort = null;
    } else if (reduceOnly && existingPosition?.side === 'long') {
      // Only the short (reducing) order is valid; its computed result is
      // the new long liq → display it in the Long slot and null Short.
      finalLong = liqShort;
      finalShort = null;
    } else if (reduceOnly && existingPosition?.side === 'short') {
      // Mirror: long (reducing) order's result is the new short liq.
      finalShort = liqLong;
      finalLong = null;
    } else {
      // RO off. Check implicit reduce-only: an opposing order whose size
      // fits inside the existing position will auto-act as reduce-only
      // at submit time. Null the order-side slot so the label doesn't
      // lie about a non-existent short/long position.
      if (reduceOnlyEligibleLong) {
        // long order reduces existing short → no long position results
        finalLong = null;
      }
      if (reduceOnlyEligibleShort) {
        // short order reduces existing long → no short position results
        finalShort = null;
      }
    }
    return {
      estLiqLong: finalLong !== null && Number.isFinite(finalLong) ? Math.max(0, finalLong) : null,
      estLiqShort: finalShort !== null && Number.isFinite(finalShort) ? Math.max(0, finalShort) : null,
    };
  }, [accountAbstractionMode, crossAccountValueUsd, crossMaintenanceMarginUsedUsd, existingPosition, leverage, marginMode, marginTiers, marketType, oraclePx, reduceOnly, reduceOnlyEligibleLong, reduceOnlyEligibleShort, roTooLarge, sizeUnits, sizeUsd, targetDexMarginAvailableUsd, tradeSide, transferablePerpUsd, unifiedSpotUsdcBalanceUsd, unifiedTotalCrossMaintenanceMarginUsedUsd, unifiedTotalIsolatedMarginUsedUsd]);

  const handleOpenSettings = useCallback(() => {
    setTempLeverage(leverage);
    tempLeverageRef.current = leverage;
    setTempMarginMode(marginMode);
    setShowSettingsModal(true);
  }, [leverage, marginMode]);

  const handleSaveSettings = useCallback(async () => {
    // Read from ref to avoid stale closure when onBlur + onPress fire in the same cycle
    const newLev = Math.min(Math.max(1, tempLeverageRef.current), maxLeverageEffective);
    setLeverage(newLev);
    setMarginMode(tempMarginMode);
    setShowSettingsModal(false);
    if (marginLookupKey) {
      await saveLeverageForSymbol(
        tradingAddress || null,
        marginLookupKey,
        newLev,
        true,
      );
      if (marginSupport) {
        await saveMarginTypeForSymbol(
          tradingAddress || null,
          marginLookupKey,
          tempMarginMode,
          effectiveSupportsCross,
          true,
        );
      }
    }
  }, [
    tradingAddress,
    marginLookupKey,
    maxLeverageEffective,
    tempMarginMode,
    marginSupport,
    effectiveSupportsCross,
  ]);

  const executeOrder = useCallback(
    async (side: 'long' | 'short') => {
      setTradeSide(side);
      if (submitGuardRef.current || submittingSide) return;
      Keyboard.dismiss();
      if (Platform.OS !== 'web') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }

      if (!isAuthenticated) {
        onAuthRequired();
        return;
      }

      // If the user dismissed setup earlier, or has an active agent but no
      // builder-fee approval, trying to trade should reopen setup before we
      // submit an order. `setupComplete` is stricter than `isAgentActive`.
      if (hasBalance && !setupComplete) {
        onSetupRequired();
        return;
      }

      const submitSizeUsd = sizeUsdManualRef.current ?? sizeUsd;
      const submitSizeUnits = oraclePx > 0 ? submitSizeUsd / oraclePx : 0;

      if (submitSizeUsd <= 0) {
        showToast(t('errors.pleaseSetSize'));
        return;
      }
      if (marketType === 'perp' && isLeveragePrefLoading) {
        showToast(t('errors.waitForMarketData'));
        return;
      }

      const reduceOnlyEligible = side === 'long' ? reduceOnlyEligibleLong : reduceOnlyEligibleShort;
      const notEnoughMarginEffectiveSide =
        side === 'long' ? notEnoughMarginLongEffective : notEnoughMarginShortEffective;
      // Defensive RO guards. The buttons are already disabled for these
      // cases, but if they ever fire (double-tap race, stale state), we
      // bail out here instead of quietly sending a bad order to HL.
      if (reduceOnly && roTooLarge) {
        showToast(t('errors.reduceOnlyTooLarge'));
        return;
      }
      if (reduceOnly && existingPosition && side === existingPosition.side) {
        // Submitting RO on the adding side would be rejected by HL anyway.
        return;
      }
      if (spotInvalidSize) {
        showToast(t('errors.minimumOrder10'));
        return;
      }
      if (notEnoughMarginEffectiveSide) {
        showToast(t('errors.notEnoughMargin'));
        return;
      }
      // Effective reduce-only flag sent to the exchange: user's explicit
      // toggle OR our implicit eligibility (opposite side + smaller-or-equal
      // size, which we've always silently set for margin-relief reasons).
      const reduceOnlyEffective = reduceOnly || reduceOnlyEligible;

      try {
        submitGuardRef.current = true;
        // Freeze the size UI to the exact notional we're about to send before
        // any JIT funding / clearinghouse updates can thrash maxUsableMargin.
        frozenSizeRef.current = {
          displaySizePct,
          sizeUsdText:
            sizeInputMode === 'pct'
              ? submitSizeUsd > 0
                ? submitSizeUsd.toFixed(2)
                : ''
              : sizeUsdText,
          sizeUnits: submitSizeUnits,
          marginRequiredUsd:
            marketType === 'spot'
              ? submitSizeUsd
              : leverage > 0
                ? submitSizeUsd / leverage
                : 0,
        };
        setSubmittingSide(side);
        if (__DEV__) {
          console.log('[QuickTradeSubmit]', {
            coin,
            symbol,
            side,
            sizeUsd: submitSizeUsd,
            sizeUnits: submitSizeUnits,
            oraclePx,
            leverage,
            marginMode,
            marketType,
            reduceOnly,
            reduceOnlyEffective,
            sizeInputMode,
            sizeUsdText,
          });
        }

        const { agentPrivateKey, agentAddress } = await ensureAgentKey();

        if (!agentPrivateKey || !agentAddress) {
          showToast(t('errors.agentKeyNotReady'));
          return;
        }

        let res: any;
        if (marketType === 'spot') {
          if (!spotAvailable) {
            showToast(t('errors.spotTradingNotAvailable'));
            return;
          }
          if (side === 'short' && submitSizeUnits > spotBaseAvailable.available + 1e-9) {
            showToast(t('errors.notEnoughSpotBalance'));
            return;
          }
          const spotOrderSizeUnits = side === 'short' ? Math.min(submitSizeUnits, spotBaseAvailable.available) : undefined;
          if (__DEV__) {
            console.log('[QuickTradeSpotSubmit]', {
              coin,
              symbol,
              spotSymbol: spotAssetData?.spotSymbol,
              spotBaseCoin: spotAssetData?.baseCoin,
              side,
              sizeUsd: submitSizeUsd,
              sizeUnits: submitSizeUnits,
              spotOrderSizeUnits,
              spotBaseAvailable: spotBaseAvailable.available,
              oraclePx,
              szDecimals: spotAssetData?.szDecimals,
              pxDecimals: spotAssetData?.pxDecimals,
              sizeInputMode,
              sizeUsdText,
              sizePct,
            });
          }
          res = await placeSpotOrder({
            agentPrivateKey: agentPrivateKey as `0x${string}`,
            symbol: spotAssetData?.spotSymbol || symbol,
            side: side === 'long' ? 'buy' : 'sell',
            orderType: 'market',
            sizeUsd: submitSizeUsd,
            sizeUnits: spotOrderSizeUnits,
            referencePx: oraclePx,
            slippageBps: 50,
            vaultAddress,
          });
        } else {
          // JIT sendAsset funding for Standard-mode perp DEX balances.
          // `placeOrder` moves free USDC between main/xyz as needed before
          // opening orders; it no-ops for reduce-only, unified/portfolio, or
          // Dedicated vault books (margin must already be on the sub).
          const getFreshProvider = async () =>
            getUserWalletProvider
              ? await getUserWalletProvider().catch(() => undefined)
              : undefined;
          const submitPerpOrder = (provider: Eip1193Provider | undefined) =>
            placeOrder({
              agentPrivateKey: agentPrivateKey as `0x${string}`,
              symbol: coin, // Use coin (e.g., "xyz:XYZ100") instead of symbol (e.g., "NDX100") for API calls
              side,
              orderType: 'market',
              sizeUsd: submitSizeUsd,
              oraclePx,
              // Live WS mid (same as trade screen). placeOrder skips the
              // weight-20 metaAndAssetCtxs fetch when this is set; REST
              // remains the fallback if WS/oracle is missing.
              referencePx: oraclePx,
              limitPx: undefined,
              reduceOnly: reduceOnlyEffective,
              leverage,
              isCross: marginMode === 'cross',
              marginSupport: marginSupport ?? undefined, // Pass pre-fetched margin support to avoid redundant API call
              userWalletProvider: provider,
              userAddress: embeddedAddress,
              hip3DexBalanceUsd: isHip3 ? crossAccountValueUsd : undefined,
              mainDexAvailableUsdc: mainDexWithdrawableUsd,
              targetDexMarginAvailableUsd,
              perpWithdrawableByDex,
              // Unified / portfolio-margin source budget for JIT spot → HIP-3
              // funding. Same cushioned helper the slider/Max uses, so a 100%
              // slider order can never exceed what HL will let through.
              unifiedSpotPoolFreeUsd: isHlPooledAccount ? unifiedSpotTransferableUsd : undefined,
              accountAbstractionMode: accountAbstractionMode ?? null,
              vaultAddress,
            });
          const provider = await getFreshProvider();
          try {
            res = await submitPerpOrder(provider);
          } catch (err: any) {
            if (!isHip3 || !isWalletTypedDataSigningError(err)) {
              throw err;
            }
            await new Promise((resolve) => setTimeout(resolve, 350));
            const refreshedProvider = await getFreshProvider();
            try {
              res = await submitPerpOrder(refreshedProvider ?? provider);
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
          showToast(h.message, h.title);
        } else {
          if (onOrderSuccessAlert) {
            onOrderSuccessAlert();
          } else {
            showToast(t('trading.orderSubmittedSuccess'), t('trading.orderSubmitted'));
          }

          // Track trade with Firebase Analytics (source: quick_trade)
          Analytics.logTrade(
            coin || symbol || 'UNKNOWN',
            side === 'long' ? 'buy' : 'sell',
            submitSizeUsd,
            'market',
            'quick_trade'
          );

          // Report trade for rewards tracking (fire-and-forget)
          if (embeddedAddress && submitSizeUsd > 0) {
            getAccessToken().then((token) => {
              if (token) {
                reportTrade(embeddedAddress, token).catch(() => {});
              }
            });
          }

          // Refresh local spot balances right after an HL spot fill so the
          // user can flip Buy ↔ Sell on the same card and immediately see
          // the new base / USDC balance. We do this twice — once now to
          // invalidate the cached snapshot, and once after ~1.5 s because
          // HL's spotClearinghouseState is eventually consistent and a
          // poll fired the same tick as the order ack often returns the
          // pre-fill `total`.
          if (marketType === 'spot') {
            refetchSpotState().catch(() => {});
            setTimeout(() => {
              refetchSpotState().catch(() => {});
            }, 1500);
          }

          // Await the parent refetch chain so the submit spinner lives until
          // the new order / position actually appears in PortfolioTabs.
          await Promise.resolve(onOrderSuccess());
        }
      } catch (e: any) {
        const msg = e?.message ? String(e.message) : 'Order failed';
        const h = humanizeHyperliquidError(msg);
        showToast(h.message, h.title);
      } finally {
        setSubmittingSide(null);
        submitGuardRef.current = false;
      }
    },
    [
      hasBalance,
      isAuthenticated,
      setupComplete,
      leverage,
      isLeveragePrefLoading,
      marginMode,
      marketType,
      notEnoughMarginLongEffective,
      notEnoughMarginShortEffective,
      reduceOnlyEligibleLong,
      reduceOnlyEligibleShort,
      reduceOnly,
      roTooLarge,
      existingPosition,
      onAuthRequired,
      onOrderSuccess,
      onOrderSuccessAlert,
      onSetupRequired,
      oraclePx,
      sizeUnits,
      sizeInputMode,
      spotAvailable,
      spotBaseAvailable.available,
      spotPair,
      sizeUsd,
      sizeUsdText,
      displaySizePct,
      marginRequiredUsd,
      symbol,
      coin,
      getUserWalletProvider,
      refetchSpotState,
      vaultAddress,
      embeddedAddress,
      marginSupport,
      isHip3,
      crossAccountValueUsd,
      mainDexWithdrawableUsd,
      targetDexMarginAvailableUsd,
      perpWithdrawableByDex,
      isHlPooledAccount,
      unifiedSpotTransferableUsd,
      accountAbstractionMode,
      getAccessToken,
      t,
    ]
  );

  const transferAvailableUsd = useMemo(() => {
    if (isHlPooledAccount) return 0;
    return transferDirection === 'toPerp' ? spotBalances.available : mainDexTransferAvailableUsd;
  }, [isHlPooledAccount, mainDexTransferAvailableUsd, spotBalances.available, transferDirection]);

  const handleTransferMax = useCallback(() => {
    if (!Number.isFinite(transferAvailableUsd)) return;
    // Reduce by 0.01 to avoid "not enough balance" errors from rounding/timing
    const maxAmount = Math.max(0, transferAvailableUsd - 0.01);
    setTransferAmountText(maxAmount > 0 ? maxAmount.toFixed(2) : '');
  }, [transferAvailableUsd]);

  useEffect(() => {
    if (transferModalOpen && isHlPooledAccount) {
      setTransferModalOpen(false);
      setTransferAmountText('');
    }
  }, [isHlPooledAccount, transferModalOpen]);

  const submitTransfer = useCallback(async () => {
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
      if (!getUserWalletProvider) {
        showToast(t('errors.pleaseConnectWallet'));
        return;
      }
      const provider = await getUserWalletProvider();
      await transferUsdBetweenSpotAndPerp({
        userWalletProvider: provider,
        userAddress: embeddedAddress,
        amountUsd: amountNum.toFixed(2),
        toPerp: transferDirection === 'toPerp',
      });
      refetchSpotState();
      setTransferAmountText('');
      setTransferModalOpen(false);
      showToast(t('portfolio.transferSubmitted'));
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : 'Transfer failed';
      const h = humanizeHyperliquidError(msg);
      showToast(h.message, h.title);
    } finally {
      setIsTransferring(false);
    }
  }, [
    embeddedAddress,
    getUserWalletProvider,
    isHlPooledAccount,
    refetchSpotState,
    transferAmountText,
    transferAvailableUsd,
    transferDirection,
  ]);

  return (
    <KeyboardAwareScrollView
      contentContainerStyle={styles.container}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      bounces={false}
    >
      {/* Header with settings */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          {marketType === 'perp' ? (
            <>
              <TouchableOpacity style={styles.modeBadge} onPress={handleOpenSettings} activeOpacity={0.7}>
                <Text style={styles.modeBadgeText}>
                  {marginMode === 'cross' ? t('trading.cross') : t('trading.isolated')} · {leverage}x
                </Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.settingsButton} onPress={handleOpenSettings}>
                <Ionicons name="pencil" size={12} color={colors.text.tertiary} />
              </TouchableOpacity>
            </>
          ) : (
            <View style={styles.modeBadge}>
              <Text style={styles.modeBadgeText}>{t('trading.spot')}</Text>
            </View>
          )}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {/* In demo mode the perp/spot badge is replaced by a DEMO badge.
              Demo restricts the universe to vetted perps (see index.tsx),
              so the perp/spot toggle is not user-relevant in this mode. */}
          {/* Spot-only: no right badge — left header already shows Spot */}
          {isDemo ? (
            <DemoBadge />
          ) : isSpotOnly ? null : canToggleSpot ? (
            <TouchableOpacity style={styles.marketBadge} onPress={() => setShowMarketTypeModal(true)}>
              <Text style={styles.marketBadgeText}>{marketType === 'spot' ? t('trading.marketTypeSpot') : t('trading.marketTypePerp')}</Text>
              <Ionicons name="information-circle" size={12} color={colors.accent.gold} />
            </TouchableOpacity>
          ) : (
            <View style={styles.marketBadge}>
              <Text style={styles.marketBadgeText}>{t('trading.marketTypePerp')}</Text>
            </View>
          )}
        </View>
      </View>
      <View style={[
        styles.availableRowCompact,
        { marginTop: -6 },
        isSpotOnly ? { marginBottom: 4 } : null,
      ]}>
        <Text style={styles.availableText}>
          {t('portfolio.available', {
            amount:
              marketType === 'spot'
                ? (tradeSide === 'long' ? availableUsdLong : availableUsdShort).toFixed(2)
                : showOrderAvailableAmount
                  ? availableUsd.toFixed(2)
                  : '—',
          })}
        </Text>
        {!isHlPooledAccount ? (
          <TouchableOpacity onPress={() => setTransferModalOpen(true)}>
            <Text style={styles.transferLink}>{t('portfolio.transfer')}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      {/*
       * DISABLED: Trade Balance / perp·spot breakdown row + Balance modal trigger.
       * Kept for easy restore if reverting unified-only UX. Modal & state remain below.
       *
      <View style={[styles.availableRowCompact, { marginTop: 4, marginBottom: 6 }]}>
        <Text style={styles.availableSubText}>
          {isHlPooledAccount
              ? `${t('deposit.tradeBalance', 'Trade Balance')} $${withdrawableUsd.toFixed(2)} · ${t('trading.spot')} ${spotBalances.hasData || spotBaseAvailable.hasData
                  ? `$${spotTotalUsd.toFixed(2)}`
                  : '--'}`
            : `${t('portfolio.perp')} $${hlPerpOrderAvailableUsd.toFixed(2)} · ${t('trading.spot')} ${spotBalances.hasData || spotBaseAvailable.hasData
                ? `$${spotTotalUsd.toFixed(2)}`
                : '--'}`}
        </Text>
        {(canToggleSpot && (spotBalances.hasData || spotBaseAvailable.hasData)) ? (
          <TouchableOpacity onPress={() => setBalanceModalOpen(true)}>
            <Text style={styles.transferLink}>{t('portfolio.balance')}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      */}

      {/* Size Inputs */}
      <View style={styles.sliderSection}>
        {marketType === 'spot' && (
          <View style={styles.sideToggleRow}>
            <TouchableOpacity
              style={[styles.sideToggleButton, tradeSide === 'long' && styles.sideToggleButtonActive]}
              onPress={() => setTradeSide('long')}
            >
              <Text style={[styles.sideToggleText, tradeSide === 'long' && styles.sideToggleTextActive]}>{t('trading.buy')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.sideToggleButton, tradeSide === 'short' && styles.sideToggleButtonActive]}
              onPress={() => setTradeSide('short')}
            >
              <Text style={[styles.sideToggleText, tradeSide === 'short' && styles.sideToggleTextActive]}>{t('trading.sell')}</Text>
            </TouchableOpacity>
          </View>
        )}
        <View style={styles.sizeInputRow}>
          <View style={styles.sizeInputGroup}>
            <Text style={styles.sizeInputLabel}>{t('trading.sizePercent')}</Text>
            <View style={styles.sizeInputWrap}>
              <TextInput
                value={sizePctDraft ?? formatSizePctNumber(uiDisplaySizePct)}
                onFocus={() => {
                  if (isSizeInputLocked) return;
                  setSizePctDraft(formatSizePctNumber(uiDisplaySizePct));
                }}
                onChangeText={(txt) => {
                  setSizePctDraft(txt);
                  const num = parseFloat(txt.replace(/[^0-9.]/g, ''));
                  if (Number.isFinite(num)) {
                    handleSizePctChange(clampSizePct(num));
                  } else if (txt === '' || txt === '.') {
                    handleSizePctChange(0);
                  }
                }}
                onBlur={() => setSizePctDraft(null)}
                keyboardType="decimal-pad"
                editable={!isSizeInputLocked}
                style={[styles.sizeInput, sizeInputMode === 'pct' && styles.sizeInputActive]}
                placeholder="0"
                placeholderTextColor={colors.text.tertiary}
              />
              <Text style={styles.sizeInputSuffix}>%</Text>
            </View>
          </View>
          <View style={styles.sizeInputGroup}>
            <Text style={styles.sizeInputLabel}>{t('trading.sizeUsd')}</Text>
            <View style={styles.sizeInputWrap}>
              <Text style={styles.sizeInputPrefix}>$</Text>
              <TextInput
                value={uiSizeUsdText}
                onChangeText={handleSizeUsdChange}
                onFocus={() => {
                  ignoreUsdTextEchoRef.current = false;
                }}
                onBlur={() => {
                  if (isSizeInputLocked) return;
                  // Clamp to max available on blur
                  const maxSizeUsd = marketType === 'spot' ? availableUsdLong : maxUsableMarginUsd * leverage;
                  const parsed = parseUsdNotional(sizeUsdText);
                  if (Number.isFinite(parsed) && parsed > maxSizeUsd) {
                    sizeUsdManualRef.current = maxSizeUsd;
                    setSizeUsdManual(maxSizeUsd);
                    setSizeUsdText(maxSizeUsd.toFixed(2));
                  }
                }}
                keyboardType="decimal-pad"
                editable={!isSizeInputLocked}
                style={[styles.sizeInput, styles.sizeInputUsd, sizeInputMode === 'usd' && styles.sizeInputActive]}
                placeholder="0.00"
                placeholderTextColor={colors.text.tertiary}
              />
            </View>
          </View>
        </View>

        <View style={styles.sizePresetScrollWrap}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            bounces={false}
            alwaysBounceHorizontal={false}
            overScrollMode="never"
            nestedScrollEnabled
            directionalLockEnabled
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.sizePresetRow}
          >
            {SIZE_USD_PRESETS.map((preset) => {
              const affordable = preset.usd <= maxSizeUsdForPresets + 1e-9;
              const selected = affordable && sizeUsd > 0 && Math.abs(sizeUsd - preset.usd) < 0.51;
              const disabled = isSizeInputLocked || !affordable;
              return (
                <TouchableOpacity
                  key={preset.usd}
                  style={[
                    styles.sizePresetChip,
                    selected && styles.sizePresetChipActive,
                    disabled && styles.sizePresetChipDisabled,
                  ]}
                  onPress={() => handleSizeUsdPreset(preset.usd)}
                  disabled={disabled}
                  activeOpacity={0.75}
                >
                  <Text
                    style={[
                      styles.sizePresetText,
                      selected && styles.sizePresetTextActive,
                      disabled && styles.sizePresetTextDisabled,
                    ]}
                    numberOfLines={1}
                  >
                    {preset.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
          <LinearGradient
            colors={[`${colors.background.primary}00`, colors.background.primary]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.sizePresetFade}
            pointerEvents="none"
          />
        </View>
        
        <LeverageSlider
          min={0}
          max={100}
          value={uiDisplaySizePct}
          onChange={handleSizePctChange}
          label=""
          formatValue={formatSizePct}
          enableHaptics={false}
          disabled={isSizeInputLocked}
        />
        <Text style={[styles.sizeHint, showCalculating && styles.calculating]}>
          ≈ {uiSizeUnits.toFixed(4)} {symbol}
        </Text>
        {notEnoughMarginEffective && sizeUsd > 0 && (
          <Text style={styles.errorText}>{t('errors.notEnoughMarginForSize')}</Text>
        )}

        {/*
          Reduce-Only toggle. Only appears when a perp position is open on
          this coin — otherwise it's a no-op that'd just confuse users on a
          fresh market. Gold when active to match the rest of the card's
          emphasis accents.
        */}
        {roAvailable && (
          <View style={styles.reduceOnlyWrap}>
            <View style={styles.reduceOnlyRow}>
              {/* Checkbox toggles RO on/off without opening the explainer. */}
              <TouchableOpacity
                onPress={() => setReduceOnly((v) => !v)}
                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                activeOpacity={0.7}
              >
                <Ionicons
                  name={reduceOnly ? 'checkbox' : 'square-outline'}
                  size={16}
                  color={reduceOnly ? colors.accent.gold : colors.text.tertiary}
                />
              </TouchableOpacity>
              {/* Label is a separate tap target that only opens the info
                  modal — matches how TP/SL labels work on the trade page
                  so users who aren't interested can ignore the details. */}
              <TouchableOpacity
                onPress={() => setShowReduceOnlyInfo(true)}
                activeOpacity={0.7}
              >
                <DashedUnderline
                  text={t('trading.reduceOnly')}
                  textStyle={[
                    styles.reduceOnlyLabel,
                    reduceOnly && { color: colors.accent.gold },
                  ]}
                />
              </TouchableOpacity>
            </View>
            {roTooLarge && (
              <Text style={styles.errorText}>{t('errors.reduceOnlyTooLarge')}</Text>
            )}
          </View>
        )}
      </View>

      {/* Compact Trade Preview */}
      <View style={[styles.previewRow, showCalculating && styles.calculating]}>
        <View style={styles.previewItem}>
          <Text style={styles.previewLabel}>{t('trading.price')}</Text>
          <Text style={styles.previewValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
            ${formatPreviewPrice(markPxNum)}
          </Text>
          <CurrencyHint usd={markPxNum} />
        </View>
        {marketType === 'spot' ? (
          <>
            <View style={styles.previewItem}>
              <Text style={styles.previewLabel}>{t('portfolio.balance')}</Text>
              <Text style={styles.previewValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
                ${availableUsdLong.toFixed(2)}
              </Text>
            </View>
            <View style={styles.previewItem}>
              <Text style={styles.previewLabel}>{t('trading.unit')}</Text>
              <Text style={styles.previewValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
                {tradeSide === 'long'
                  ? (Number.isFinite(uiSizeUnits) ? `${uiSizeUnits.toFixed(4)} ${symbol}` : '--')
                  : (Number.isFinite(spotBaseAvailable.available) ? `${spotBaseAvailable.available.toFixed(4)} ${symbol}` : '--')}
              </Text>
            </View>
            <View style={styles.previewItem}>
              <Text style={styles.previewLabel}>{t('trading.type')}</Text>
              <Text style={styles.previewValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
                {t('trading.spot')}
              </Text>
            </View>
          </>
        ) : (
          <>
            <View style={styles.previewItem}>
              <Text style={styles.previewLabel}>{t('trading.margin')}</Text>
              <Text style={styles.previewValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
                ${uiMarginRequiredUsd.toFixed(2)}
              </Text>
              <CurrencyHint usd={uiMarginRequiredUsd} />
            </View>
            <View style={styles.previewItem}>
              <Text style={[styles.previewLabel, { color: colors.status.success }]} numberOfLines={1}>
                {t('trading.liqLong')}
              </Text>
              <Text
                style={[
                  styles.previewValue,
                  { color: colors.status.success },
                  !estLiqLong && styles.previewValueUnavailable,
                ]}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.7}
              >
                {estLiqLong ? `$${formatPriceSmart(estLiqLong)}` : t('common.notAvailable')}
              </Text>
              {estLiqLong ? <CurrencyHint usd={estLiqLong} /> : null}
            </View>
            <View style={styles.previewItem}>
              <Text style={[styles.previewLabel, { color: colors.status.error }]} numberOfLines={1}>
                {t('trading.liqShort')}
              </Text>
              <Text
                style={[
                  styles.previewValue,
                  { color: colors.status.error },
                  !estLiqShort && styles.previewValueUnavailable,
                ]}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.7}
              >
                {estLiqShort ? `$${formatPriceSmart(estLiqShort)}` : t('common.notAvailable')}
              </Text>
              {estLiqShort ? <CurrencyHint usd={estLiqShort} /> : null}
            </View>
          </>
        )}
      </View>

      {/* Long / Short Buttons */}
      <View style={styles.buttonsRow}>
        <TouchableOpacity
          style={[
            styles.actionButton,
            styles.longButton,
            (submittingSide !== null ||
              noSizeSet ||
              notEnoughMarginLongEffective ||
              spotInvalidSize ||
              roDisablesLong ||
              (marketType === 'spot' && tradeSide !== 'long')) &&
              styles.buttonDisabled,
          ]}
          onPress={() => {
            if (marketType === 'spot' && tradeSide !== 'long') {
              setTradeSide('long');
              return;
            }
            sharedAiGuard(() => {
              void executeOrder('long');
            });
          }}
          disabled={
            submittingSide !== null ||
            noSizeSet ||
            notEnoughMarginLongEffective ||
            spotInvalidSize ||
            roDisablesLong ||
            (marketType === 'spot' && tradeSide !== 'long')
          }
        >
          {submittingSide === 'long' ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <>
              {!notEnoughMarginLongEffective && (
                <Ionicons name="trending-up" size={18} color="#fff" />
              )}
              <Text style={styles.buttonText}>
                {spotInvalidSize
                  ? `${t('trading.min')} $${spotMinUsdRequired.toFixed(2)}`
                  : notEnoughMarginLongEffective
                    ? t('errors.notEnoughMargin')
                    : marketType === 'spot' ? t('trading.buy').toUpperCase() : t('trading.long').toUpperCase()}
              </Text>
            </>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.actionButton,
            styles.shortButton,
            (submittingSide !== null ||
              noSizeSet ||
              notEnoughMarginShortEffective ||
              !canSellSpot ||
              spotInvalidSize ||
              roDisablesShort ||
              (marketType === 'spot' && tradeSide !== 'short')) &&
              styles.buttonDisabled,
          ]}
          onPress={() => {
            if (marketType === 'spot' && !canSellSpot) {
              showToast(t('errors.noSpotBalanceToSell'));
              return;
            }
            if (marketType === 'spot' && tradeSide !== 'short') {
              setTradeSide('short');
              return;
            }
            sharedAiGuard(() => {
              void executeOrder('short');
            });
          }}
          disabled={
            submittingSide !== null ||
            noSizeSet ||
            notEnoughMarginShortEffective ||
            !canSellSpot ||
            spotInvalidSize ||
            roDisablesShort ||
            (marketType === 'spot' && tradeSide !== 'short')
          }
        >
          {submittingSide === 'short' ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <>
              {!notEnoughMarginShortEffective && (
                <Ionicons name="trending-down" size={18} color="#fff" />
              )}
              <Text style={styles.buttonText}>
                {spotInvalidSize
                  ? `${t('trading.min')} $${spotMinUsdRequired.toFixed(2)}`
                  : notEnoughMarginShortEffective
                    ? t('errors.notEnoughMargin')
                    : marketType === 'spot' ? t('trading.sell').toUpperCase() : t('trading.short').toUpperCase()}
              </Text>
            </>
          )}
        </TouchableOpacity>
      </View>

      {/* Reduce-Only info modal (tapping the dashed label opens this). */}
      <Modal
        visible={showReduceOnlyInfo}
        transparent
        animationType="fade"
        onRequestClose={() => setShowReduceOnlyInfo(false)}
      >
        <TouchableOpacity
          style={styles.modalBackdrop}
          activeOpacity={1}
          onPress={() => setShowReduceOnlyInfo(false)}
        >
          <TouchableOpacity style={styles.modalCard} activeOpacity={1}>
            <Text style={styles.modalTitle}>{t('trading.reduceOnly')}</Text>
            <Text style={styles.modalText}>{t('trading.reduceOnlyHint')}</Text>
            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={styles.modalPrimary}
                onPress={() => setShowReduceOnlyInfo(false)}
              >
                <Text style={styles.modalPrimaryText}>{t('common.gotIt')}</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Transfer Modal */}
      <Modal visible={transferModalOpen} transparent animationType="fade">
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
                  {t('trading.spot')} → {t('portfolio.perp')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.transferToggleButton, transferDirection === 'toSpot' && styles.transferToggleButtonActive]}
                onPress={() => setTransferDirection('toSpot')}
              >
                <Text style={[styles.transferToggleText, transferDirection === 'toSpot' && styles.transferToggleTextActive]}>
                  {t('portfolio.perp')} → {t('trading.spot')}
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

      {/* Balance Modal */}
      <Modal visible={balanceModalOpen} transparent animationType="fade">
        <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setBalanceModalOpen(false)}>
          <TouchableOpacity style={styles.modalCard} activeOpacity={1}>
            <Text style={styles.modalTitle}>{t('portfolio.balanceBreakdown')}</Text>

                <View style={styles.modalRow}>
                  <Text style={styles.modalLabel}>{t('portfolio.usdcBalance')}</Text>
                  <Text style={styles.modalValue}>${spotBalances.available.toFixed(2)}</Text>
                </View>
                
                <View style={styles.modalRow}>
                  <Text style={styles.modalLabel}>{symbol?.toUpperCase() || t('common.asset')} {t('portfolio.balance')}</Text>
                  <Text style={styles.modalValue}>
                    {spotBaseAvailable.available.toFixed(4)} {symbol?.toUpperCase() || ''}
                  </Text>
                </View>
                
                <View style={styles.modalRow}>
                  <Text style={styles.modalLabel}>{symbol?.toUpperCase() || t('common.asset')} {t('portfolio.valueUsd')}</Text>
                  <Text style={styles.modalValue}>${spotBaseUsd.toFixed(2)}</Text>
                </View>
                
                <View style={[styles.modalRow, { borderTopWidth: 1, borderTopColor: colors.border.primary, marginTop: 8, paddingTop: 12 }]}>
                  <Text style={[styles.modalLabel, { fontWeight: '800', color: colors.text.primary }]}>{t('portfolio.totalSpotBalance')}</Text>
                  <Text style={[styles.modalValue, { fontWeight: '900', color: colors.accent.gold }]}>
                    ${spotTotalUsd.toFixed(2)}
                  </Text>
                </View>

            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.modalPrimary} onPress={() => setBalanceModalOpen(false)}>
                <Text style={styles.modalPrimaryText}>{t('common.close')}</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      <Modal
        visible={showMarketTypeModal && canToggleSpot}
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
                <Text style={[styles.transferToggleText, marketType === 'perp' && styles.transferToggleTextActive]}>{t('trading.marketTypePerp')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.transferToggleButton,
                  marketType === 'spot' && styles.transferToggleButtonActive,
                  !canToggleSpot && styles.modePillDisabled,
                ]}
                onPress={() => {
                  if (!canToggleSpot) return;
                  setMarketType('spot');
                  setShowMarketTypeModal(false);
                }}
                disabled={!canToggleSpot}
              >
                <Text
                  style={[
                    styles.transferToggleText,
                    marketType === 'spot' && styles.transferToggleTextActive,
                    !canToggleSpot && styles.modePillTextDisabled,
                  ]}
                >
                  {t('trading.marketTypeSpot')}
                </Text>
              </TouchableOpacity>
            </View>
            {!canToggleSpot ? (
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

      {/* Settings Modal */}
      <Modal visible={showSettingsModal} transparent animationType="fade">
        <TouchableOpacity
          style={styles.modalBackdrop}
          activeOpacity={1}
          onPress={() => setShowSettingsModal(false)}
        >
          <GestureHandlerRootView style={styles.gestureRoot}>
            <TouchableOpacity style={styles.modalCard} activeOpacity={1}>
            <Text style={styles.modalTitle}>{t('trading.quickTradeSettings')}</Text>

            {/* Margin Mode */}
            <Text style={styles.modalLabel}>{t('trading.marginModes')}</Text>
            {(() => {
              // Resting limit orders also pin margin mode (HL re-leverages
              // them silently otherwise — see prop docs above).
              const posLocked = existingPosition?.marginType ?? restingOrderLock?.marginType;
              const isolatedDisabled = posLocked === 'cross';
              const crossDisabled = !effectiveSupportsCross || posLocked === 'isolated';
              return (
                <View style={styles.modePills}>
                  <TouchableOpacity
                    style={[
                      styles.modePill,
                      tempMarginMode === 'isolated' && styles.modePillActive,
                      isolatedDisabled && styles.modePillDisabled,
                    ]}
                    onPress={() => { if (!isolatedDisabled) setTempMarginMode('isolated'); }}
                    disabled={isolatedDisabled}
                  >
                    <Text
                      style={[
                        styles.modePillText,
                        tempMarginMode === 'isolated' && styles.modePillTextActive,
                        isolatedDisabled && styles.modePillTextDisabled,
                      ]}
                    >
                      {t('trading.isolated')}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.modePill,
                      tempMarginMode === 'cross' && styles.modePillActive,
                      crossDisabled && styles.modePillDisabled,
                    ]}
                    onPress={() => { if (!crossDisabled) setTempMarginMode('cross'); }}
                    disabled={crossDisabled}
                  >
                    <Text
                      style={[
                        styles.modePillText,
                        tempMarginMode === 'cross' && styles.modePillTextActive,
                        crossDisabled && styles.modePillTextDisabled,
                      ]}
                    >
                      {t('trading.cross')}
                    </Text>
                  </TouchableOpacity>
                </View>
              );
            })()}
            {(existingPosition?.marginType || restingOrderLock?.marginType) && (
              <Text style={styles.leverageLockedHint}>
                🔒 {t('trading.marginLocked', {
                  mode: (existingPosition?.marginType ?? restingOrderLock?.marginType) === 'cross'
                    ? t('trading.cross')
                    : t('trading.isolated'),
                })}
              </Text>
            )}
            {/* HIP-3 + standard-mode → cross is gated by HL itself; show
                a hint instead of letting the user wonder why the toggle
                is disabled (matches the pop-up HL's own UI shows). */}
            {!existingPosition?.marginType &&
              isHip3 &&
              !!marginSupport?.supportsCross &&
              !canUseCrossOnAsset(true, accountAbstractionMode) && (
                null
              )}

            {/* Leverage */}
            <Text style={[styles.modalLabel, { marginTop: 16 }]}>{t('trading.leverage')}</Text>
            <LeverageSlider
              min={1}
              max={maxLeverageEffective}
              value={tempLeverage}
              onChange={handleTempLeverageChange}
              allowInput
              inputSuffix="x"
              disabled={!!(
                (existingPosition && marginMode === 'isolated') ||
                (restingOrderLock?.leverage != null && restingOrderLock?.marginType === marginMode)
              )}
            />
            {((existingPosition && marginMode === 'isolated') ||
              (restingOrderLock?.leverage != null && restingOrderLock?.marginType === marginMode)) && (
              <Text style={styles.leverageLockedHint}>
                🔒 {t('trading.leverageLocked', {
                  leverage: existingPosition && marginMode === 'isolated'
                    ? existingPosition.leverage
                    : restingOrderLock?.leverage,
                })}
              </Text>
            )}

            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={styles.modalSecondary}
                onPress={() => setShowSettingsModal(false)}
              >
                <Text style={styles.modalSecondaryText}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalPrimary} onPress={handleSaveSettings}>
                <Text style={styles.modalPrimaryText}>{t('common.save')}</Text>
              </TouchableOpacity>
            </View>
            </TouchableOpacity>
          </GestureHandlerRootView>
        </TouchableOpacity>
      </Modal>
      {sharedAiModal}
    </KeyboardAwareScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  headerTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: colors.text.primary,
  },
  modeBadge: {
    backgroundColor: `${colors.accent.gold}20`,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  modeBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.accent.gold,
  },
  settingsButton: {
    padding: 4,
    borderRadius: 6,
    backgroundColor: colors.background.tertiary,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  availableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: -6,
  },
  availableRowCompact: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  availableText: {
    color: colors.text.tertiary,
    fontSize: 11,
    fontWeight: '600',
  },
  availableSubText: {
    color: colors.text.tertiary,
    fontSize: 11,
    fontWeight: '600',
  },
  transferLink: {
    color: colors.accent.gold,
    fontSize: 11,
    fontWeight: '700',
  },
  marketBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.accent.gold,
    backgroundColor: `${colors.accent.gold}20`,
  },
  marketBadgeText: { color: colors.accent.gold, fontSize: 10, fontWeight: '800' },
  sliderSection: {
    marginBottom: 8,
  },
  sideToggleRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  sideToggleButton: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 10,
    alignItems: 'center',
    backgroundColor: colors.background.tertiary,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  sideToggleButtonActive: {
    backgroundColor: `${colors.accent.gold}25`,
    borderColor: colors.accent.gold,
  },
  sideToggleText: {
    color: colors.text.secondary,
    fontSize: 12,
    fontWeight: '800',
  },
  sideToggleTextActive: {
    color: colors.accent.gold,
  },
  sizeInputRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 10,
  },
  sizeInputGroup: {
    flex: 1,
  },
  sizeInputLabel: {
    fontSize: 11,
    color: colors.text.tertiary,
    fontWeight: '700',
    marginBottom: 4,
  },
  sizeInputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.background.tertiary,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border.primary,
    paddingHorizontal: 10,
  },
  sizeInput: {
    flex: 1,
    paddingVertical: 8,
    color: colors.text.primary,
    fontSize: 14,
    fontWeight: '700',
  },
  sizeInputUsd: {
    paddingLeft: 2,
  },
  sizeInputActive: {
    // Active state handled by border
  },
  sizeInputPrefix: {
    color: colors.text.tertiary,
    fontSize: 14,
    fontWeight: '700',
  },
  sizeInputSuffix: {
    color: colors.text.tertiary,
    fontSize: 13,
    fontWeight: '700',
  },
  sizePresetScrollWrap: {
    position: 'relative',
    marginBottom: 6,
  },
  sizePresetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingRight: 20,
  },
  sizePresetFade: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: 24,
  },
  sizePresetChip: {
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background.tertiary,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  sizePresetChipActive: {
    backgroundColor: `${colors.accent.gold}25`,
    borderColor: colors.accent.gold,
  },
  sizePresetChipDisabled: {
    opacity: 0.38,
  },
  sizePresetText: {
    color: colors.text.secondary,
    fontSize: 10,
    fontWeight: '800',
  },
  sizePresetTextActive: {
    color: colors.accent.gold,
  },
  sizePresetTextDisabled: {
    color: colors.text.tertiary,
  },
  sizeHint: {
    fontSize: 12,
    color: colors.text.tertiary,
    fontWeight: '600',
    marginTop: 4,
  },
  calculating: {
    opacity: 0.5,
  },
  errorText: {
    fontSize: 11,
    color: colors.status.error,
    fontWeight: '600',
    marginTop: 4,
  },
  previewRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: colors.background.tertiary,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  previewItem: {
    flex: 1,
    alignItems: 'center',
    minWidth: 0,
  },
  previewLabel: {
    fontSize: 9,
    color: colors.text.tertiary,
    fontWeight: '700',
    marginBottom: 2,
    textAlign: 'center',
    width: '100%',
  },
  previewValue: {
    fontSize: 11,
    color: colors.text.primary,
    fontWeight: '800',
    textAlign: 'center',
    width: '100%',
  },
  previewValueUnavailable: {
    fontSize: 9,
    fontWeight: '600',
    lineHeight: 12,
  },
  buttonsRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 30,
    marginBottom: 8,
  },
  actionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 10,
    gap: 6,
  },
  longButton: {
    backgroundColor: colors.status.success,
  },
  shortButton: {
    backgroundColor: colors.status.error,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    fontSize: 14,
    fontWeight: '800',
    color: '#fff',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    padding: 20,
  },
  gestureRoot: {
    width: '100%',
  },
  modalCard: {
    backgroundColor: colors.background.primary,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border.primary,
    padding: 16,
  },
  modalTitle: {
    color: colors.text.primary,
    fontSize: 16,
    fontWeight: '900',
    marginBottom: 16,
  },
  modalText: {
    color: colors.text.tertiary,
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 8,
  },
  modalLabel: {
    color: colors.text.tertiary,
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 8,
  },
  leverageLockedHint: {
    color: colors.accent.gold,
    fontSize: 9,
    fontWeight: '600',
    marginTop: 6,
    textAlign: 'center',
  },
  // Reduce-Only toggle block. Sits below the size inputs so the hint reads
  // as a natural footnote to the size decision the user is making.
  reduceOnlyWrap: {
    marginTop: 10,
  },
  reduceOnlyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  reduceOnlyLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.text.secondary,
  },
  transferToggleRow: { flexDirection: 'row', gap: 8, marginTop: 8, marginBottom: 8 },
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
  modePills: {
    flexDirection: 'row',
    gap: 8,
  },
  modePill: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
    backgroundColor: colors.background.tertiary,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  modePillActive: {
    backgroundColor: `${colors.accent.gold}25`,
    borderColor: colors.accent.gold,
  },
  modePillDisabled: {
    opacity: 0.5,
  },
  modePillText: {
    color: colors.text.secondary,
    fontSize: 12,
    fontWeight: '800',
  },
  modePillTextActive: {
    color: colors.accent.gold,
  },
  modePillTextDisabled: {
    color: colors.text.tertiary,
  },
  modalButtons: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 20,
  },
  modalSecondary: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    backgroundColor: colors.background.tertiary,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  modalSecondaryText: {
    color: colors.text.primary,
    fontSize: 13,
    fontWeight: '800',
  },
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
  modalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  modalValue: {
    color: colors.text.primary,
    fontSize: 13,
    fontWeight: '700',
  },
});
