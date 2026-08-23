import React, { useMemo, useState, memo, useEffect, useCallback, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Modal, TextInput } from 'react-native';
import Animated, {
  Easing,
  FadeOut,
  LinearTransition,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useTranslation } from 'react-i18next';
import { colors } from '../theme/colors';
import { showToast } from '../lib/toast';
import { useQuery } from '@tanstack/react-query';
import { getSpotSymbolMap } from '../lib/hyperliquid';
import { humanizeHyperliquidError } from '../lib/hyperliquidErrors';
import { pushRouteOnce } from '../lib/pushRouteOnce';
import { DemoBadge } from './DemoMode';
import { PortfolioTabSkeleton } from './PortfolioTabSkeleton';
import { AiReasoningModal } from './AiReasoningModal';
import { useSharedAiTradeGuard } from '../hooks/useSharedAiTradeGuard';
import { useAuth } from '../providers/AuthContext';
import { fetchAiAgentPositions, type AiAgentPosition } from '../lib/api';
import { isAiAgentCloid } from '../lib/aiAgentCloid';
import { findAiPositionForLive } from '../lib/aiPositionMatch';
import { useAppStore } from '../store/appStore';
import { useLiveAssetCtxs } from '../providers/WebSocketProvider';
import { getPriceLookupKeys, pickPrice } from '../lib/priceKeys';
import { formatDisplaySymbol as formatAppDisplaySymbol, getDisplayAssetRouteSymbol } from '../lib/displaySymbols';

const HISTORY_DISPLAY_LIMIT = 7;
/** Positions / Orders soft page size — Show more reveals the next chunk. */
const LIST_PAGE_SIZE = 10;
const ACTION_COLUMN_WIDTH = 92;
const ENABLE_ORDER_EDIT = true;
const BULK_EXIT_STAGGER_MS = 18;
const BULK_EXIT_MAX_DELAY_MS = 144;
const CRITICAL_PRICE_STALE_MS = 10_000;

/** Sibling reflow when a row is removed — no spring (avoids bounce when the list reflows). */
const ROW_LAYOUT_TRANSITION = LinearTransition.duration(200);
/** Exit when row unmounts — ease-out so it reads clearly even for the last item */
const ROW_EXITING = FadeOut.duration(240).easing(Easing.out(Easing.cubic));

/**
 * Parents set `closingPositionKey` as `${symbol}:${szi}` (captured at click time).
 * We intentionally match on the SYMBOL prefix only — during a close the stream may
 * push intermediate szi values (partial fills, funding ticks, sign-flip through 0
 * for shorts). Comparing exact strings makes the pulse state flicker on/off, which
 * looked like a retry loop. Symbol-level match is safe: HL allows one position per
 * coin per account.
 */
function closingKeyMatchesPosition(closingKey: string | null, p: any): boolean {
  if (!closingKey) return false;
  const coin = String(p?.coin ?? '');
  // Key format is `${coin}:${szi}`. HIP-3 coins themselves contain ':'
  // (e.g. `xyz:MSTR`), so splitting on ':' would reduce the key to `xyz`
  // and the optimistic close state would never match the row.
  return coin !== '' && (closingKey === coin || closingKey.startsWith(`${coin}:`));
}

function positionRenderKey(p: any): string {
  const explicitId = p?.positionId ?? p?.pid ?? p?.id;
  if (explicitId != null && String(explicitId) !== '') {
    return `position:${String(explicitId)}`;
  }
  const coin = String(p?.coin ?? '');
  const source = p?.isSpot ? 'spot' : String(p?.source ?? 'hl');
  const baseCoin = String(p?.baseCoin ?? '');
  // NOTE: identity is (source, coin, baseCoin) only — intentionally NO side/sign
  // and NO marginType.
  //   - side/sign: when closing a short, szi passes through 0 (Math.sign flips),
  //     which would change the key and force an unmount/remount mid-close —
  //     visually indistinguishable from a retry loop.
  //   - marginType: every page derives it from the WS frame as
  //       `lev?.type === 'cross' ? 'cross' : 'isolated'`
  //     so any frame that omits `leverage` (HL pushes partial updates during
  //     rapid liq-price ticks) silently flips a real cross position to
  //     'isolated' for one frame and back. That flipped the row's React key,
  //     unmounted the old row (which kept fading out for FadeOut.duration(240))
  //     while the new row mounted immediately in the same slot — the user saw
  //     two position cards stacked on top of each other for ~240ms. HL allows
  //     one position per (account, coin); the cross/iso badge re-renders fine
  //     through normal prop updates without changing identity.
  return `position:${source}:${coin}:${baseCoin}`;
}

function extractOpenOrderOid(o: any): number | null {
  const oid = Number(o?.oid ?? o?.order?.oid ?? o?.o?.oid);
  return Number.isFinite(oid) ? oid : null;
}

/** Placement clock — HL payloads use `timestamp` (ms). Modify updates this. */
function extractOpenOrderTime(o: any): number {
  const order = o?.order ?? o?.o ?? o;
  const t = Number(order?.timestamp ?? o?.timestamp ?? order?.time ?? o?.time ?? 0);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Identity that survives an in-place edit. Limit `modify` keeps `oid`.
 * Position TP/SL is cancel+replace (new oid), so key those by coin+tpsl
 * and keep the first-seen clock across the brief gap.
 */
function openOrderStickyKey(o: any): string {
  const order = o?.order ?? o?.o ?? o;
  const tpsl = order?.tpsl ?? o?.tpsl;
  const coin = String(order?.coin ?? o?.coin ?? '');
  if ((tpsl === 'tp' || tpsl === 'sl') && coin) return `tpsl:${coin}:${tpsl}`;
  const oid = extractOpenOrderOid(o);
  if (oid != null) return `oid:${oid}`;
  const cloid = order?.cloid ?? o?.cloid;
  if (cloid) return `cloid:${String(cloid)}`;
  return `row:${coin}:${extractOpenOrderTime(o)}`;
}

const TPSL_STICKY_GRACE_MS = 15_000;

/**
 * Newest-first by first-seen time (not last-modified). WS/REST snapshots
 * reshuffle their arrays and HL bumps `timestamp` on modify — sorting on
 * the live clock would send an edited row to the top.
 */
function sortOpenOrdersSticky(
  orders: any[],
  firstSeen: Map<string, number>,
  absentSince: Map<string, number>,
  now: number,
): any[] {
  const present = new Set<string>();
  for (const o of orders) {
    const key = openOrderStickyKey(o);
    present.add(key);
    absentSince.delete(key);
    if (!firstSeen.has(key)) {
      const t = extractOpenOrderTime(o);
      firstSeen.set(key, t > 0 ? t : now);
    }
  }
  for (const key of [...firstSeen.keys()]) {
    if (present.has(key)) continue;
    if (!absentSince.has(key)) absentSince.set(key, now);
    const ttl = key.startsWith('tpsl:') ? TPSL_STICKY_GRACE_MS : 0;
    if (now - (absentSince.get(key) ?? now) >= ttl) {
      firstSeen.delete(key);
      absentSince.delete(key);
    }
  }
  return [...orders].sort((a, b) => {
    const tb = firstSeen.get(openOrderStickyKey(b)) ?? extractOpenOrderTime(b);
    const ta = firstSeen.get(openOrderStickyKey(a)) ?? extractOpenOrderTime(a);
    if (tb !== ta) return tb - ta;
    return (extractOpenOrderOid(b) ?? 0) - (extractOpenOrderOid(a) ?? 0);
  });
}

function normalizePortfolioCoinKey(v?: string | null): string {
  return String(v ?? '').trim().toUpperCase();
}

function findPositionForSymbol(positionsList: any[], symbol: string): any | undefined {
  const target = normalizePortfolioCoinKey(symbol);
  if (!target) return undefined;
  return positionsList.find((p: any) => normalizePortfolioCoinKey(p?.coin) === target);
}

function stripDexPrefix(coin: string): string {
  return coin.includes(':') ? coin.split(':').slice(1).join(':') : coin;
}

/**
 * True when the traded asset already has a live row (perp or spot).
 * Used to skip the post-submit skeleton on add/reduce — that placeholder
 * is only for a brand-new position card, not an in-place size update.
 */
function hasLivePositionForAsset(
  positionsList: any[],
  opts: {
    symbol?: string | null;
    routeCoin?: string | null;
    isSpot?: boolean | null;
    spotSymbolMap?: { bySymbol?: Record<string, { baseCoin?: string }> } | null;
  },
): boolean {
  const queries = [opts.routeCoin, opts.symbol]
    .map((v) => normalizePortfolioCoinKey(v))
    .filter(Boolean);
  if (!queries.length || !positionsList.length) return false;
  return positionsList.some((p: any) => {
    const rowIsSpot = !!p?.isSpot;
    if (opts.isSpot === true && !rowIsSpot) return false;
    if (opts.isSpot === false && rowIsSpot) return false;
    const rowKeys = [
      p?.coin,
      p?.baseCoin,
      getDisplayAssetRouteSymbol(p?.coin, opts.spotSymbolMap),
    ]
      .map((v) => normalizePortfolioCoinKey(v))
      .filter(Boolean);
    return queries.some((q) => {
      const qDisp = normalizePortfolioCoinKey(getDisplayAssetRouteSymbol(q, opts.spotSymbolMap));
      const qStrip = stripDexPrefix(q);
      return rowKeys.some((r) => r === q || r === qDisp || stripDexPrefix(r) === qStrip);
    });
  });
}

type PortfolioPendingSnap = {
  positionKeys: Set<string>;
  orderOids: Set<string>;
};

/** Upper bound for the post-submit shimmer while the new row is in flight. */
const PENDING_SKELETON_MAX_WAIT_MS = 6000;

function capturePortfolioPendingSnap(positions: any[], orders: any[]): PortfolioPendingSnap {
  return {
    positionKeys: new Set(positions.map((p) => positionRenderKey(p))),
    orderOids: new Set(
      orders
        .map(extractOpenOrderOid)
        .filter((id): id is number => id != null)
        .map(String),
    ),
  };
}

/** New list row (popup), not an in-place size/PnL tick on an existing row. */
function hasNewPortfolioRow(snap: PortfolioPendingSnap, positions: any[], orders: any[]): boolean {
  for (const p of positions) {
    if (!snap.positionKeys.has(positionRenderKey(p))) return true;
  }
  for (const o of orders) {
    const oid = extractOpenOrderOid(o);
    if (oid != null && !snap.orderOids.has(String(oid))) return true;
  }
  return false;
}

function rowExitForIndex(index: number, isBulkAction: boolean) {
  if (!isBulkAction) return ROW_EXITING;
  const delay = Math.min(BULK_EXIT_MAX_DELAY_MS, Math.max(0, index) * BULK_EXIT_STAGGER_MS);
  return FadeOut.duration(220).delay(delay).easing(Easing.out(Easing.cubic));
}

/**
 * Minimum visible duration for close/cancel spinners.
 *
 * Problem: HL market close occasionally resolves the full round-trip
 * (agent-key fetch → order → refetchTradingState) faster than one React paint.
 * When that happens the `closingPositionKey` prop flips on and off between
 * frames, and the `positions` array also drops the row in the same tick — so
 * the user's Close button snaps straight to "no positions" without ever
 * rendering the <ActivityIndicator/>. Cancel-order usually shows the spinner
 * because the network round-trip is slower, but we shouldn't rely on that.
 *
 * Fix: hold the processing key locally for at least SPINNER_MIN_MS after the
 * parent clears it. No-op when the op takes longer than that (effective key
 * just tracks the prop). Applied to both close-position and cancel-order so
 * the UX stays consistent.
 */
const SPINNER_MIN_MS = 450;
// React Native Modal's built-in `fade` dismiss runs ~200ms on both platforms.
// We match it so the close action fires the instant the backdrop clears —
// any less and the backdrop still obscures the row; any more and the tap
// feels laggy.
const MODAL_DISMISS_MS = 200;
function useHeldKey<T extends string | number | null>(key: T): T {
  const [heldKey, setHeldKey] = useState<T>(key);
  const setAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (key != null) {
      setAtRef.current = Date.now();
      setHeldKey(key);
      return;
    }
    const setAt = setAtRef.current;
    const elapsed = setAt != null ? Date.now() - setAt : Infinity;
    if (elapsed >= SPINNER_MIN_MS) {
      setHeldKey(key);
      setAtRef.current = null;
      return;
    }
    const remaining = SPINNER_MIN_MS - elapsed;
    const id = setTimeout(() => {
      setHeldKey(key);
      setAtRef.current = null;
    }, remaining);
    return () => clearTimeout(id);
  }, [key]);
  return heldKey;
}

type PortfolioTab = 'positions' | 'orders' | 'history';

type PositionTpslPayload = {
  coin: string;
  entrySide: 'long' | 'short';
  entryPx: number;
  markPx: number;
  sizeUnits: number;
  marginUsedUsd?: number;
  leverage?: number;
};

type PnlSharePayload = {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  pnlPercent: number;
  entryPrice: number;
  markPrice: number;
  leverage?: number;
};

type ModifyOrderPayload = {
  symbol: string;
  oid: number;
  side: 'buy' | 'sell';
  sizeUnits: string;
  referencePx?: number;
  isSpot: boolean;
  reduceOnly?: boolean;
  cloid?: string | null;
  isTrigger?: boolean;
  tpsl?: 'tp' | 'sl';
};

type Props = {
  portfolioTab: PortfolioTab;
  onTabChange: (next: PortfolioTab) => void;
  positions: any[];
  openOrders: any[];
  ordersCountOverride?: number;
  fills: any[];
  livePrices?: Record<string, { price?: string; time?: number }>;
  hip3Prices?: Record<string, string>;
  fundingRates?: Record<string, string | number | null | undefined>;
  fundingAccrued?: Record<string, number | string | null | undefined>;
  activeAssetData?: Record<string, any>;
  spotBalances?: any[];
  currentAssetSymbol?: string;
  currentAssetMarkPx?: string | null;
  /**
   * `/asset/[coin]` segment for the screen that embeds these tabs (same value
   * you pass as the asset route param). When set, rows on the same market
   * suppress the chevron jump control; rows on a different coin OR a
   * different perp/spot orientation still show it. Omit on the global
   * portfolio screen so every row is tappable.
   */
  assetRouteCoin?: string | null;
  /**
   * Whether the embedding `/asset/[coin]` screen is currently in spot mode
   * (i.e. `?market=spot` or a spot-only asset). Used together with
   * `assetRouteCoin` to discriminate dual-listed coins like HYPE/BTC/ETH/SOL,
   * so the chevron is suppressed only when BOTH the coin AND the spot/perp
   * orientation match the row. Without this, the HYPE spot row on
   * `/asset/HYPE?market=spot` would hide the chevron for the perp row and
   * show one for the spot row (the inverse of what we want).
   */
  assetRouteIsSpot?: boolean | null;
  /**
   * How chevron taps navigate to /asset/[coin]. Use 'replace' when the embedding
   * screen is itself an /asset/[coin] page so swapping coins doesn't stack new
   * mounts on top of the current one (each push spins up a fresh chart, WS subs,
   * queries, refs — multiplied per back-and-forth tap). 'push' is correct from
   * the global portfolio screen and from /trade/[coin] (different route family).
   * Default 'push' to preserve existing behaviour.
   */
  navigationMode?: 'push' | 'replace';
  /** Default/fallback margin mode (used when position doesn't have marginType) */
  marginMode: 'isolated' | 'cross';
  closingPositionKey: string | null;
  cancelingOrderId: number | null;
  isSubmitting: boolean;
  pnlShareLoading: boolean;
  isCloseAllLoading?: boolean;
  isCancelAllLoading?: boolean;
  showMarginMode?: boolean;
  noHorizontalMargin?: boolean;
  onClosePosition: (symbol: string, szi: string) => void;
  onCancelOrder: (symbol: string, oid: number) => void;
  onCloseAllPositions?: () => void;
  onCancelAllOrders?: () => void;
  onModifyOrder?: (payload: ModifyOrderPayload, nextLimitPx: number) => Promise<void>;
  onOpenTpsl: (payload: PositionTpslPayload) => void;
  onSharePositionPnl: (payload: PnlSharePayload) => void;
  onShareFillPnl: (payload: PnlSharePayload) => void;
  formatPrice: (price: string | null | undefined) => string;
  formatPriceNum: (n: number | null | undefined) => string;
  formatSignedUsd: (n: number) => string;
  safeNum: (x: any) => number;
  formatShortTime: (ms: number | string | null | undefined) => string;
  /**
   * Shimmer rows while portfolio REST/stream data is still bootstrapping.
   * Only replaces the empty-state copy when the active tab has no rows.
   * Revert: remove prop + skeleton branches below.
   */
  isInitialPortfolioLoading?: boolean;
  /**
   * Parent-driven post-submit signal (e.g. asset Quick Trade refetch).
   * Skeleton only when the book was empty and a new row is expected — not for
   * in-place size changes on existing rows.
   */
  pendingSkeletonRowCount?: number;
  /**
   * When set, bot badges match that Dedicated agent's OPEN rows only.
   * When null/omit (Master book), badges are Shared/copilot only.
   */
  aiScopeAgentId?: string | null;
  /**
   * Dedicated sub-account books: view fills/positions, but hide close/cancel/TP-SL
   * (master-signed sub trading is not wired on this screen yet).
   */
  actionsReadOnly?: boolean;
  /**
   * Identity of the REST snapshot currently painted (e.g. last committed book).
   * When this changes, skip Reanimated layout/exit so book switches don't bounce
   * the list (FadeOut + LinearTransition on a full row swap).
   */
  accountLayoutKey?: string | null;
};

type ProcessingRowProps = {
  layout?: any;
  exiting?: any;
  isProcessing: boolean;
  children: React.ReactNode;
};

/**
 * Row wrapper that keeps layout + exit animations clean.
 *
 * History: we previously ran a repeating opacity/scale pulse on an inner View
 * while the row was "processing". That inner shared-value animation fought with
 * the outer `FadeOut` exit (the two opacities multiplied, and the cleanup reset
 * happened on the same frame as the exit), which caused the exit to visually
 * vanish whenever >1 row remained in the list. Since the ActivityIndicator in
 * the action column already communicates "processing", we dropped the pulse
 * entirely — `LinearTransition` + `FadeOut` now run without interference.
 *
 * Three layers, each with exactly one responsibility — Reanimated warns
 * ("Property 'opacity' of AnimatedComponent(View) may be overwritten by a
 * layout animation") whenever a built-in animation (layout OR entering OR
 * exiting) writes a prop that the same view's style also sets. `FadeOut`
 * animates opacity, and the processing dim is a static `opacity: 0.72`, so
 * they MUST live on different views:
 *   - Outer Animated.View: owns the layout animation only (no opacity).
 *   - Middle Animated.View: owns the exit (`FadeOut` → opacity). No static
 *     opacity in its style.
 *   - Inner plain View: owns the static processing dim. Not animated at all,
 *     so nothing clashes with the exit's opacity writer above it.
 */
const ProcessingRow = memo(function ProcessingRow({
  layout,
  exiting,
  isProcessing,
  children,
}: ProcessingRowProps) {
  return (
    <Animated.View layout={layout} style={styles.positionRow}>
      <Animated.View exiting={exiting} style={styles.positionRowInner}>
        <View style={isProcessing ? styles.positionRowProcessing : undefined}>
          {children}
        </View>
      </Animated.View>
    </Animated.View>
  );
});

/** Neutral chip matching symbol / leverage (not LONG/SHORT pills). */
function MetaBadge({ label }: { label: string }) {
  return (
    <View style={styles.symbolBadge}>
      <Text style={styles.symbolBadgeText}>{label}</Text>
    </View>
  );
}

/**
 * Subtle pulsing green dot used to hint that a value ticks live. Reanimated is
 * already in scope so we reuse it instead of pulling in RN's Animated API.
 */
const LivePulseDot = memo(function LivePulseDot() {
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.value = withRepeat(
      withTiming(1, { duration: 900, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [progress]);
  const style = useAnimatedStyle(() => ({
    opacity: 0.45 + progress.value * 0.55,
    transform: [{ scale: 0.9 + progress.value * 0.25 }],
  }));
  return (
    <Animated.View
      style={[
        {
          width: 7,
          height: 7,
          borderRadius: 4,
          backgroundColor: colors.status.success,
        },
        style,
      ]}
    />
  );
});

export const PortfolioTabs = memo(function PortfolioTabs({
  portfolioTab,
  onTabChange,
  positions,
  openOrders,
  ordersCountOverride,
  fills,
  livePrices,
  hip3Prices,
  activeAssetData,
  spotBalances,
  currentAssetSymbol,
  currentAssetMarkPx,
  assetRouteCoin,
  assetRouteIsSpot,
  navigationMode = 'push',
  marginMode,
  closingPositionKey,
  cancelingOrderId,
  isSubmitting,
  pnlShareLoading,
  isCloseAllLoading,
  isCancelAllLoading,
  showMarginMode = true,
  noHorizontalMargin = false,
  onClosePosition,
  onCancelOrder,
  onCloseAllPositions,
  onCancelAllOrders,
  onModifyOrder,
  onOpenTpsl,
  onSharePositionPnl,
  onShareFillPnl,
  formatPrice,
  formatPriceNum,
  formatSignedUsd,
  safeNum,
  formatShortTime,
  isInitialPortfolioLoading = false,
  pendingSkeletonRowCount = 0,
  aiScopeAgentId = null,
  actionsReadOnly = false,
  accountLayoutKey = null,
}: Props) {
  const { t } = useTranslation();
  const router = useRouter();
  const tradingEnv = useAppStore((s) => s.tradingEnv);
  const isDemo = tradingEnv === 'demo';
  // Demo mode (HL testnet) — when true, render a small DEMO badge on the
  // left of the actions row above each tab so users tracking positions /
  // orders are reminded these are testnet values.
  const [confirmAction, setConfirmAction] = useState<null | 'close_all' | 'cancel_all'>(null);
  const [confirmClosePosition, setConfirmClosePosition] = useState<null | { coin: string; szi: string }>(null);
  const [showFilterModal, setShowFilterModal] = useState(false);
  const [filterSymbol, setFilterSymbol] = useState<string | null>(null);
  const [positionsVisibleCount, setPositionsVisibleCount] = useState(LIST_PAGE_SIZE);
  const [ordersVisibleCount, setOrdersVisibleCount] = useState(LIST_PAGE_SIZE);
  const [editOrderModal, setEditOrderModal] = useState<ModifyOrderPayload | null>(null);
  const [editLimitPxText, setEditLimitPxText] = useState('');
  const [editSizeText, setEditSizeText] = useState('');
  const [editOrderError, setEditOrderError] = useState<string | null>(null);
  const [editOrderLoading, setEditOrderLoading] = useState(false);
  const perpPositionCoins = useMemo(() => {
    return Array.from(new Set(
      (positions ?? [])
        .filter((p: any) => !(!!p?.isSpot || String(p?.coin ?? '').startsWith('@')))
        .map((p: any) => String(p?.coin ?? ''))
        .filter(Boolean),
    )).sort();
  }, [positions]);
  const liveAssetCtxs = useLiveAssetCtxs(perpPositionCoins);

  // ── AI agent positions (bot badge + Reasoning button) ────────────────────
  // Agent-tracked open positions for this user, keyed by coin. A matching coin
  // gets a bot badge and a Reasoning action. Deliberately additive: the row
  // itself (and Close / TP/SL) behaves identically to a manual position, per
  // product decision to not change how orders are tracked.
  const { isAuthenticated: aiAuth, getAccessToken: aiGetToken } = useAuth();
  const { data: aiPositions } = useQuery({
    queryKey: ['ai_agent_positions', tradingEnv],
    queryFn: async () => {
      const token = await aiGetToken();
      if (!token) return [] as AiAgentPosition[];
      return fetchAiAgentPositions(token);
    },
    enabled: aiAuth,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const aiPosByCoin = useMemo(() => {
    const map = new Map<string, AiAgentPosition>();
    const scopeId = aiScopeAgentId ? String(aiScopeAgentId) : null;
    for (const ap of aiPositions ?? []) {
      if ((ap.tradingEnv === 'demo') !== isDemo) continue;
      // Master book: Shared/copilot only. Dedicated book: that agent only.
      if (scopeId) {
        if (ap.agentId !== scopeId) continue;
      } else if (ap.agentMode !== 'copilot') {
        continue;
      }
      map.set(ap.symbol.toUpperCase(), ap);
    }
    return map;
  }, [aiPositions, isDemo, aiScopeAgentId]);
  const [reasoningModal, setReasoningModal] = useState<null | {
    agentId: string;
    agentName: string;
    symbol: string;
    direction: 'LONG' | 'SHORT';
    openedAt: string;
  }>(null);

  const { guard: sharedAiGuard, modal: sharedAiModal } = useSharedAiTradeGuard({
    symbol: null,
    marketType: 'perp',
    enabled: aiAuth && !aiScopeAgentId && !actionsReadOnly,
  });

  const effectiveCloseAll = actionsReadOnly ? undefined : onCloseAllPositions;
  const effectiveCancelAll = actionsReadOnly ? undefined : onCancelAllOrders;

  /**
   * Optimistic spinner bridge for close/cancel.
   *
   * `useHeldKey` below covers the *tail* of the op (parent clears the prop →
   * hold 450ms more). That's not enough on its own: the *head* — the gap
   * between the user's tap and the parent's `setClosingPositionKey` actually
   * shipping a render — can collapse into a single React commit when the
   * network is fast (cached agent key + sub-100ms HL response). In that case
   * the row gets removed from `positions` in the same commit where the prop
   * briefly flipped on+off, so `<ActivityIndicator/>` never paints.
   *
   * Cancel usually survives this because there's no confirm modal — one tap
   * calls the parent directly. Close goes through the modal, so the parent's
   * `setClosingPositionKey` is queued inside an async handler that fires
   * alongside the modal dismissal → easier to compress into one commit.
   *
   * Fix: set an optimistic key synchronously in the tap handler (same event
   * that dismisses the modal / fires the cancel), BEFORE awaiting anything.
   * `combined = parentProp ?? optimistic` so the parent's real prop wins once
   * it's set; the optimistic value only fills the tap→parent-render gap.
   * Auto-cleared after OPTIMISTIC_TTL_MS — by then the parent's prop has
   * definitely taken over (or the handler errored early and there's nothing
   * to hold for). `useHeldKey` then handles the tail as before.
   */
  const OPTIMISTIC_TTL_MS = 1000;
  const [optimisticClosingKey, setOptimisticClosingKey] = useState<string | null>(null);
  const [optimisticCancelingOrderId, setOptimisticCancelingOrderId] = useState<number | null>(null);

  useEffect(() => {
    if (!optimisticClosingKey) return;
    const id = setTimeout(() => setOptimisticClosingKey(null), OPTIMISTIC_TTL_MS);
    return () => clearTimeout(id);
  }, [optimisticClosingKey]);

  useEffect(() => {
    if (optimisticCancelingOrderId == null) return;
    const id = setTimeout(() => setOptimisticCancelingOrderId(null), OPTIMISTIC_TTL_MS);
    return () => clearTimeout(id);
  }, [optimisticCancelingOrderId]);

  const combinedClosingPositionKey = closingPositionKey ?? optimisticClosingKey;
  const combinedCancelingOrderId = cancelingOrderId ?? optimisticCancelingOrderId;
  const effectiveClosingPositionKey = useHeldKey(combinedClosingPositionKey);
  const effectiveCancelingOrderId = useHeldKey(combinedCancelingOrderId);

  /**
   * Bulk close/cancel stragglers.
   *
   * Problem: parent's `isCloseAllLoading` / `isCancelAllLoading` flips to
   * false as soon as its `Promise.all(closeOrders)` resolves. But `positions`
   * / `openOrders` are driven by a separate WS feed, and the last fill/cancel
   * can lag the promise by up to ~1s. During that gap the last row briefly
   * re-shows the "Close Position" / "Cancel Order" button (no spinner) before
   * the WS drops it — user sees a ghost row that "didn't close".
   *
   * Fix: snapshot the row keys at bulk-tap time, flip a local
   * `bulkCloseActive` / `bulkCancelActive` flag, and hold it true until every
   * snapshotted row is absent from the list (or a safety timeout fires, so a
   * failed close doesn't leave rows spinning forever). The existing
   * `isBulkCloseProcessing` / `isBulkCancelProcessing` checks below consume
   * this combined flag, so stragglers keep their spinner until they actually
   * unmount.
   */
  const BULK_SAFETY_MS = 6000;
  const bulkCloseSnapshotRef = useRef<Set<string>>(new Set());
  const bulkCancelSnapshotRef = useRef<Set<number>>(new Set());
  const bulkCloseSafetyRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bulkCancelSafetyRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [bulkCloseActive, setBulkCloseActive] = useState(false);
  const [bulkCancelActive, setBulkCancelActive] = useState(false);

  const clearBulkCloseHold = useCallback(() => {
    bulkCloseSnapshotRef.current.clear();
    setBulkCloseActive(false);
    if (bulkCloseSafetyRef.current) {
      clearTimeout(bulkCloseSafetyRef.current);
      bulkCloseSafetyRef.current = null;
    }
  }, []);

  const clearBulkCancelHold = useCallback(() => {
    bulkCancelSnapshotRef.current.clear();
    setBulkCancelActive(false);
    if (bulkCancelSafetyRef.current) {
      clearTimeout(bulkCancelSafetyRef.current);
      bulkCancelSafetyRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (bulkCloseSafetyRef.current) clearTimeout(bulkCloseSafetyRef.current);
      if (bulkCancelSafetyRef.current) clearTimeout(bulkCancelSafetyRef.current);
    };
  }, []);

  const { data: spotSymbolMap } = useQuery({
    queryKey: ['hl_spot_symbol_map', tradingEnv],
    queryFn: getSpotSymbolMap,
    staleTime: 5 * 60 * 1000,
  });

  // Reset filter + list window when switching tabs
  useEffect(() => {
    setFilterSymbol(null);
    setPositionsVisibleCount(LIST_PAGE_SIZE);
    setOrdersVisibleCount(LIST_PAGE_SIZE);
  }, [portfolioTab]);

  // Symbol filter change → collapse back to the first page
  useEffect(() => {
    setPositionsVisibleCount(LIST_PAGE_SIZE);
    setOrdersVisibleCount(LIST_PAGE_SIZE);
  }, [filterSymbol]);

  // Limit history display and sort by most recent (fills should already be sorted, but ensure)
  const displayedFills = useMemo(() => {
    // Hyperliquid returns fills sorted by time descending (most recent first)
    return fills.slice(0, HISTORY_DISPLAY_LIMIT);
  }, [fills]);

  const hasMoreFills = fills.length > HISTORY_DISPLAY_LIMIT;
  
  const [priceNow, setPriceNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setPriceNow(Date.now()), 2_000);
    return () => clearInterval(id);
  }, []);

  const getLivePrice = useCallback(
    (coin: string) => {
      for (const key of getPriceLookupKeys({ coin, isHip3: coin.includes(':') })) {
        const live = livePrices?.[key];
        if (live?.price) {
          const age = priceNow - (live.time ?? 0);
          if (live.time && age <= CRITICAL_PRICE_STALE_MS) return live.price;
          return undefined;
        }
      }
      return pickPrice(hip3Prices, { coin, isHip3: coin.includes(':') });
    },
    [hip3Prices, livePrices, priceNow],
  );

  // Compute fill-based cost basis once (stable — only changes when fills change)
  const spotCostByBase = useMemo(() => {
    const bySymbol = spotSymbolMap?.bySymbol ?? {};
    const fillsForSpot = Array.isArray(fills) ? fills : [];
    const costByBase: Record<string, { qty: number; cost: number }> = {};
    const sorted = [...fillsForSpot];
    sorted.sort((a, b) => Number(a?.time ?? 0) - Number(b?.time ?? 0));
    sorted.forEach((f) => {
      const coin = String(f?.coin ?? f?.symbol ?? f?.asset ?? '');
      // HL spot fills use @-prefix symbols
      let base: string | undefined;
      if (coin.startsWith('@')) {
        base = bySymbol?.[coin]?.baseCoin;
      }
      if (!base) return;
      const px = safeNum(f?.px ?? f?.price ?? f?.fillPx);
      const sz = Math.abs(safeNum(f?.sz ?? f?.size ?? f?.qty));
      if (!Number.isFinite(px) || !Number.isFinite(sz) || sz <= 0) return;
      const sideRaw = String(f?.side ?? f?.dir ?? f?.orderSide ?? '').toLowerCase();
      const isBuy = sideRaw === 'b' || sideRaw === 'buy' || sideRaw === 'long';
      const current = costByBase[base] ?? { qty: 0, cost: 0 };
      if (isBuy) {
        current.cost += sz * px;
        current.qty += sz;
      } else if (current.qty > 0) {
        const sold = Math.min(current.qty, sz);
        const reduceCost = (current.cost * sold) / Math.max(1e-9, current.qty);
        current.cost -= reduceCost;
        current.qty -= sold;
        if (current.qty <= 1e-12) {
          current.qty = 0;
          current.cost = 0;
        }
      }
      costByBase[base] = current;
    });
    return costByBase;
  }, [fills, safeNum, spotSymbolMap]);

  const spotPositions = useMemo(() => {
    if (!spotBalances || !spotBalances.length) return [];
    const byBase = spotSymbolMap?.byBase ?? {};
    const byToken = spotSymbolMap?.byToken ?? {};
    const szDecimalsByBase = spotSymbolMap?.szDecimalsByBase ?? {};
    const szDecimalsBySymbol = spotSymbolMap?.szDecimalsBySymbol ?? {};
    return spotBalances
      .map((b: any) => {
        const tokenKey = b?.token != null ? String(b.token) : '';
        const base = String(b?.coin || byToken[tokenKey] || '').toUpperCase();
        if (!base || base === 'USDC') return null;
        const total = safeNum(b?.total);
        const hold = safeNum(b?.hold);
        const totalSize = Number.isFinite(total) ? Math.max(0, total) : 0;
        const available = Math.max(0, totalSize - (Number.isFinite(hold) ? hold : 0));
        if (totalSize <= 0) return null;
        const spotSymbol = byBase[base];
        // Hyperliquid spot enforces a min lot of 10^-szDecimals base units.
        // Anything below that can't be sold (HL UI hides it the same way),
        // so the row would only ever produce a "Close" that throws.
        const szDec = Number(szDecimalsBySymbol[spotSymbol ?? ''] ?? szDecimalsByBase[base]);
        const minLot = Number.isFinite(szDec) ? Math.pow(10, -szDec) : 0;
        if (Number.isFinite(minLot) && minLot > 0 && totalSize < minLot) return null;
        const markPxRaw =
          (spotSymbol ? getLivePrice(spotSymbol) : undefined) ??
          (spotSymbol ? spotSymbolMap?.markPxBySymbol?.[spotSymbol] : undefined) ??
          spotSymbolMap?.markPxByBase?.[base];
        let markPxNum = markPxRaw ? parseFloat(markPxRaw) : NaN;
        if (!Number.isFinite(markPxNum) && base) {
          const fallbackRaw = getLivePrice(base);
          const fallbackNum = fallbackRaw ? parseFloat(fallbackRaw) : NaN;
          if (Number.isFinite(fallbackNum)) {
            markPxNum = fallbackNum;
          }
        }
        if (!Number.isFinite(markPxNum) && base.startsWith('U') && base.length > 1) {
          const unwrappedRaw = getLivePrice(base.slice(1));
          const unwrappedNum = unwrappedRaw ? parseFloat(unwrappedRaw) : NaN;
          if (Number.isFinite(unwrappedNum)) {
            markPxNum = unwrappedNum;
          }
        }
        const cost = spotCostByBase[base];
        // Entry price is ONLY from fills — never fall back to live mark price
        const entryPx = cost && cost.qty > 0 ? cost.cost / cost.qty : NaN;
        const valueUsd =
          Number.isFinite(markPxNum) ? totalSize * markPxNum : Number.isFinite(entryPx) ? totalSize * entryPx : NaN;
        // Hide spot rows worth less than $1. HL spot enforces a $10
        // minimum order, so anything under $10 is unsellable in practice
        // anyway, and a $1 cutoff matches HL's own UI default of hiding
        // small balances. This catches dust like the ~$0.12 USDT0
        // residue that's above the szDecimals lot floor but still
        // below any reasonable "show me my positions" threshold.
        const SPOT_DUST_USD = 1;
        if (Number.isFinite(valueUsd) && valueUsd < SPOT_DUST_USD) return null;
        return {
          coin: spotSymbol || base,
          baseCoin: base, // Store base coin for live price lookup
          spotSymbol, // Store spot symbol for live price lookup
          isSpot: true,
          entryPx,
          markPx: markPxNum,
          szi: String(totalSize),
          sizeUnits: totalSize,
          availableSizeUnits: available,
          // Min sellable lot for this spot asset; close button is gated on it.
          minLot: Number.isFinite(minLot) ? minLot : 0,
          unrealizedPnl: Number.isFinite(markPxNum) && Number.isFinite(entryPx) ? (markPxNum - entryPx) * totalSize : NaN,
          returnOnEquity: NaN,
          leverage: null,
          marginUsed: NaN,
          marginType: null,
          source: b?.source || undefined,
        };
      })
      .filter(Boolean);
  }, [spotCostByBase, getLivePrice, safeNum, spotBalances, spotSymbolMap]);

  // Render order is fully deterministic: spot block first, then perp block,
  // each sorted alphabetically by coin (Binance/Bybit/OKX-style default).
  // This is the final guard against rows flipping live — upstream sources
  // (Hyperliquid WS `assetPositions`, spot `balances`) do not
  // guarantee stable array order between frames, so without sorting here a
  // single tick can reorder the visible list and (worse) two alternating
  // frames can lock the UI into a flip-loop.
  const combinedPositions = useMemo(() => {
    const byCoin = (a: any, b: any) =>
      String(a?.coin ?? '').localeCompare(String(b?.coin ?? ''), undefined, { sensitivity: 'base' });
    const sortedSpot = [...spotPositions].sort(byCoin);
    const sortedPerp = [...positions].sort(byCoin);
    return [...sortedSpot, ...sortedPerp];
  }, [positions, spotPositions]);

  // Get unique symbols for filtering
  const availableSymbols = useMemo(() => {
    const symbols = new Set<string>();
    if (portfolioTab === 'positions') {
      combinedPositions.forEach((p: any) => symbols.add(String(p.coin)));
    } else if (portfolioTab === 'orders') {
      openOrders.forEach((o: any) => symbols.add(String(o.coin)));
    }
    return Array.from(symbols).sort();
  }, [combinedPositions, openOrders, portfolioTab]);

  useEffect(() => {
    if (filterSymbol && !availableSymbols.includes(filterSymbol)) {
      setFilterSymbol(null);
    }
  }, [availableSymbols, filterSymbol]);

  // Filter positions/orders by symbol
  const filteredPositions = useMemo(() => {
    if (!filterSymbol) return combinedPositions;
    return combinedPositions.filter((p: any) => String(p.coin) === filterSymbol);
  }, [combinedPositions, filterSymbol]);

  // Same stability guard as combinedPositions: WS/REST openOrders arrays are
  // not ordered consistently between snapshots. Pin each row to the time we
  // first saw it so a price edit does not jump the row to the top.
  const orderFirstSeenRef = useRef<Map<string, number>>(new Map());
  const orderAbsentSinceRef = useRef<Map<string, number>>(new Map());
  const orderSortBookRef = useRef(accountLayoutKey);
  if (orderSortBookRef.current !== accountLayoutKey) {
    orderSortBookRef.current = accountLayoutKey;
    orderFirstSeenRef.current.clear();
    orderAbsentSinceRef.current.clear();
  }
  const filteredOpenOrders = useMemo(() => {
    const list = !filterSymbol
      ? openOrders
      : openOrders.filter((o: any) => String(o.coin) === filterSymbol);
    return sortOpenOrdersSticky(
      list,
      orderFirstSeenRef.current,
      orderAbsentSinceRef.current,
      Date.now(),
    );
  }, [openOrders, filterSymbol, accountLayoutKey]);

  const displayedPositions = useMemo(
    () => filteredPositions.slice(0, positionsVisibleCount),
    [filteredPositions, positionsVisibleCount],
  );
  const displayedOpenOrders = useMemo(
    () => filteredOpenOrders.slice(0, ordersVisibleCount),
    [filteredOpenOrders, ordersVisibleCount],
  );
  const positionsRemaining = Math.max(0, filteredPositions.length - displayedPositions.length);
  const ordersRemaining = Math.max(0, filteredOpenOrders.length - displayedOpenOrders.length);

  const previousPositionsCountRef = useRef(filteredPositions.length);
  const previousOrdersCountRef = useRef(filteredOpenOrders.length);
  const prevAccountLayoutKeyRef = useRef(accountLayoutKey);
  const skipBookSwapRowAnim =
    accountLayoutKey != null &&
    prevAccountLayoutKeyRef.current != null &&
    prevAccountLayoutKeyRef.current !== accountLayoutKey;
  const positionsJustShrank =
    !skipBookSwapRowAnim && previousPositionsCountRef.current > filteredPositions.length;
  const ordersJustShrank =
    !skipBookSwapRowAnim && previousOrdersCountRef.current > filteredOpenOrders.length;

  useEffect(() => {
    previousPositionsCountRef.current = filteredPositions.length;
  }, [filteredPositions.length]);

  useEffect(() => {
    previousOrdersCountRef.current = filteredOpenOrders.length;
  }, [filteredOpenOrders.length]);

  useEffect(() => {
    prevAccountLayoutKeyRef.current = accountLayoutKey;
  }, [accountLayoutKey]);

  /**
   * Post-submit skeleton — only for a new row about to pop in, not in-place
   * size/PnL updates. Stays up until WS/REST adds a new position key or order
   * oid. After the parent refetch finishes, HL's clearinghouse state can lag
   * the fill by 1–2s, so if a brand-new row is still expected we keep
   * shimmering until it lands (bounded by a safety timeout) instead of
   * flashing the empty state in the gap.
   */
  const parentPendingSignal =
    Math.max(0, pendingSkeletonRowCount, isSubmitting ? 1 : 0) > 0;
  const pendingSnapRef = useRef<PortfolioPendingSnap | null>(null);
  // True when the submitted asset had no open position at submit time — a
  // successful fill must then surface a NEW row (position or resting oid).
  const pendingExpectNewPositionRef = useRef(false);
  const pendingHoldTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevParentPendingRef = useRef(false);
  const [holdPendingSkeleton, setHoldPendingSkeleton] = useState(false);

  const clearPendingSkeletonHold = useCallback(() => {
    setHoldPendingSkeleton(false);
    pendingSnapRef.current = null;
    pendingExpectNewPositionRef.current = false;
    if (pendingHoldTimeoutRef.current) {
      clearTimeout(pendingHoldTimeoutRef.current);
      pendingHoldTimeoutRef.current = null;
    }
  }, []);

  useEffect(
    () => () => {
      if (pendingHoldTimeoutRef.current) clearTimeout(pendingHoldTimeoutRef.current);
    },
    [],
  );

  useEffect(() => {
    const rising = parentPendingSignal && !prevParentPendingRef.current;
    prevParentPendingRef.current = parentPendingSignal;

    if (rising) {
      pendingSnapRef.current = capturePortfolioPendingSnap(combinedPositions, openOrders);
      const alreadyHasPosition = hasLivePositionForAsset(combinedPositions, {
        symbol: currentAssetSymbol,
        routeCoin: assetRouteCoin,
        isSpot: assetRouteIsSpot,
        spotSymbolMap,
      });
      pendingExpectNewPositionRef.current = !alreadyHasPosition;
      if (pendingHoldTimeoutRef.current) {
        clearTimeout(pendingHoldTimeoutRef.current);
        pendingHoldTimeoutRef.current = null;
      }
      // Add/reduce updates the existing card in place — a skeleton under
      // HYPE (etc.) looks like a second position. Only shimmer when a
      // new Positions row is actually expected. Orders tab still waits
      // for a new oid (limit / trigger).
      if (portfolioTab === 'positions' && alreadyHasPosition) {
        pendingSnapRef.current = null;
        setHoldPendingSkeleton(false);
        return;
      }
      setHoldPendingSkeleton(true);
      return;
    }

    const snap = pendingSnapRef.current;
    if (!snap || !holdPendingSkeleton) return;

    // WS / REST pushed a new position row or order oid — row is in the list.
    if (hasNewPortfolioRow(snap, combinedPositions, openOrders)) {
      clearPendingSkeletonHold();
      return;
    }
    if (!parentPendingSignal) {
      // Keep shimmer while a new row is still in flight:
      //  - positions tab when the traded coin had no prior position (first
      //    fill on this asset — the new row WILL pop in once HL catches up);
      //  - orders tab with an existing book waiting for the new oid.
      const waitingForNewRow =
        (portfolioTab === 'positions' && pendingExpectNewPositionRef.current) ||
        (portfolioTab === 'orders' && snap.orderOids.size > 0);
      if (!waitingForNewRow) {
        clearPendingSkeletonHold();
      } else if (!pendingHoldTimeoutRef.current) {
        // Safety valve — expected row never landed (IOC no-fill, WS drop):
        // don't shimmer forever.
        pendingHoldTimeoutRef.current = setTimeout(() => {
          pendingHoldTimeoutRef.current = null;
          clearPendingSkeletonHold();
        }, PENDING_SKELETON_MAX_WAIT_MS);
      }
    }
  }, [
    parentPendingSignal,
    holdPendingSkeleton,
    portfolioTab,
    combinedPositions,
    openOrders,
    currentAssetSymbol,
    assetRouteCoin,
    assetRouteIsSpot,
    spotSymbolMap,
    clearPendingSkeletonHold,
  ]);

  // Release bulk-close hold once every snapshotted position has left the list.
  // Guarded on bulkCloseActive so we don't re-run during idle renders.
  useEffect(() => {
    if (!bulkCloseActive) return;
    const snapshot = bulkCloseSnapshotRef.current;
    if (snapshot.size === 0) {
      clearBulkCloseHold();
      return;
    }
    const anyStillThere = filteredPositions.some((p: any) => snapshot.has(positionRenderKey(p)));
    if (!anyStillThere) clearBulkCloseHold();
  }, [bulkCloseActive, filteredPositions, clearBulkCloseHold]);

  useEffect(() => {
    if (!bulkCancelActive) return;
    const snapshot = bulkCancelSnapshotRef.current;
    if (snapshot.size === 0) {
      clearBulkCancelHold();
      return;
    }
    const anyStillThere = filteredOpenOrders.some((o: any) => {
      const oid = Number(o?.oid ?? o?.order?.oid ?? o?.o?.oid);
      return Number.isFinite(oid) && snapshot.has(oid);
    });
    if (!anyStillThere) clearBulkCancelHold();
  }, [bulkCancelActive, filteredOpenOrders, clearBulkCancelHold]);

  const displayedOrdersCount =
    typeof ordersCountOverride === 'number' && Number.isFinite(ordersCountOverride)
      ? Math.max(0, Math.floor(ordersCountOverride))
      : openOrders.length;

  const confirmTitle = useMemo(() => {
    if (confirmAction === 'close_all') return t('portfolio.closeAllPositions');
    if (confirmAction === 'cancel_all') return t('portfolio.cancelAllOrders');
    return '';
  }, [confirmAction, t]);
  const confirmBody = useMemo(() => {
    if (confirmAction === 'close_all') {
      return t('portfolio.closeAllPositionsDescription');
    }
    if (confirmAction === 'cancel_all') {
      return t('portfolio.cancelAllOrdersDescription');
    }
    return '';
  }, [confirmAction, t]);
  const confirmCta = confirmAction === 'close_all' ? t('portfolio.closeAll') : t('portfolio.cancelAll');
  const isConfirmLoading = confirmAction === 'close_all' ? !!isCloseAllLoading : !!isCancelAllLoading;

  const formatDisplaySymbol = useCallback(
    (coin: string) => {
      return formatAppDisplaySymbol(coin, spotSymbolMap);
    },
    [spotSymbolMap],
  );

  const showAssetNavForCoin = useCallback(
    (coin: string, rowIsSpot?: boolean) => {
      const row = String(coin ?? '');
      if (!row || row === '--') return false;
      const cur = assetRouteCoin != null ? String(assetRouteCoin).trim() : '';
      // Global portfolio screen → no embedding asset page, every row gets a
      // chevron.
      if (!cur) return true;
      // Normalize the row's coin to whatever the asset-page route uses.
      // Spot rows store `coin` as HL's `@N` numeric symbol (e.g. `@107` for
      // HYPE spot), while the page receives the base coin (e.g. `'HYPE'`).
      // Without this normalization the spot row would always appear
      // "different" from the current page and incorrectly show a chevron
      // that just reloads the same page.
      const routeCoin = getDisplayAssetRouteSymbol(row, spotSymbolMap);
      const normalizedCur = getDisplayAssetRouteSymbol(cur, spotSymbolMap);
      const coinMatches = routeCoin === normalizedCur;
      if (!coinMatches) return true;
      // Same base coin AND we know the page's orientation → only suppress
      // the chevron when the row's orientation matches the page. This is
      // the discriminator for dual-listed coins (HYPE/BTC/ETH/SOL/ZEC/…)
      // where a single asset page can be either the perp or spot view.
      if (assetRouteIsSpot == null || rowIsSpot == null) {
        // Either side missing → fall back to legacy coin-only equality so
        // the chevron is suppressed when the row matches the page coin.
        return false;
      }
      return !!rowIsSpot !== !!assetRouteIsSpot;
    },
    [assetRouteCoin, assetRouteIsSpot, spotSymbolMap],
  );

  const navigateToAsset = useCallback((coin: string, opts?: { isSpot?: boolean }) => {
    const routeCoin = getDisplayAssetRouteSymbol(coin, spotSymbolMap);
    // Market gating: the asset page accepts `?market=spot` to pre-select the
    // spot side. We only append it when the caller is certain the row is a
    // spot row.
    //
    // Why we don't infer from `spotSymbolMap.byBase[coin]`: assets like HYPE,
    // BTC, ETH, SOL, ZEC, ENA, MON, XPL exist on BOTH perp AND spot. A perp
    // HYPE position has `coin: 'HYPE'` which appears in `byBase` because the
    // spot pair `@107` is keyed by base 'HYPE' too — so any pure-coin lookup
    // can't tell perp from spot. The caller is the source of truth (the
    // position/order/fill row already knows its own `isSpotPosition` /
    // `isSpotOrder` / `isSpotFill` flag), so we accept it explicitly.
    //
    // Fallback when no flag is passed: the only structurally-unambiguous spot
    // shape is HL's `@N` numeric spot coin. Bare base tokens stay in perp
    // mode by default.
    const rawCoin = String(coin ?? '').toUpperCase();
    const isSpotCoin = opts?.isSpot ?? rawCoin.startsWith('@');
    const querySuffix = isSpotCoin ? '?market=spot' : '';
    const href = `/asset/${encodeURIComponent(routeCoin)}${querySuffix}`;
    if (navigationMode === 'replace') {
      // In-place swap: prevents the screen-stacking memory/chart-thrash that
      // happens when the user pivots between coins from inside an asset page.
      router.replace(href as any);
    } else {
      pushRouteOnce(router, href as any);
    }
  }, [router, navigationMode, spotSymbolMap]);

  const formatFundingLabel = useCallback(
    (rate: any, isLong: boolean) => {
      const raw = safeNum(rate);
      if (!Number.isFinite(raw)) return { text: '--', color: colors.text.primary };
      const signed = isLong ? -raw : raw;
      const pct = signed * 100;
      const sign = pct >= 0 ? '+' : '-';
      const text = `${sign}${Math.abs(pct).toFixed(4)}%`;
      const color = pct >= 0 ? colors.status.success : colors.status.error;
      return { text, color };
    },
    [safeNum],
  );

  const formatSignedUsdDisplay = useCallback(
    (n: number) => {
      const raw = formatSignedUsd(n);
      if (raw === '--') return raw;
      return raw.replace(' USDC', '');
    },
    [formatSignedUsd],
  );

  /**
   * Cents-grade signed USD formatter. The shared currency formatter uses asset-price
   * precision (up to 6 decimals for sub-cent amounts) which is useful for low-price
   * assets but noisy for dollar amounts like PnL or accrued funding — a just-opened
   * position shows "+$0.002700" instead of a clean "+$0.00". Cap the decimal tail
   * at 2 digits here without touching the price/fee formatters elsewhere.
   */
  const formatPnlDisplay = useCallback(
    (n: number) => {
      if (!Number.isFinite(n)) return '--';
      const raw = formatSignedUsdDisplay(n);
      if (raw === '--') return raw;
      // Trim any decimal tail longer than 2 digits. Works for both "$0.002700"
      // and converted "≈ +€0.0027" styles since we only touch the decimal part.
      return raw.replace(/(\.\d{2})\d+/, '$1');
    },
    [formatSignedUsdDisplay],
  );

  const getLeverageLabelFromValue = useCallback(
    (val: any) => {
      if (val == null) return null;
      const raw =
        typeof val === 'object' && val?.value != null
          ? safeNum(val.value)
          : safeNum(val?.leverage ?? val);
      if (!Number.isFinite(raw) || raw <= 0) return null;
      return `${Math.max(1, Math.round(raw))}x`;
    },
    [safeNum],
  );

  const getOrderMarginMode = useCallback(
    (order: any, posForOrder?: any): 'cross' | 'isolated' | null => {
      const raw =
        order?.isCross ??
        order?.cross ??
        order?.isCrossMargin ??
        order?.orderType?.isCross ??
        order?.t?.isCross ??
        order?.marginType ??
        order?.orderType?.marginType ??
        order?.leverage?.type ??
        order?.leverage?.isCross ??
        order?.t?.leverage?.type ??
        order?.orderType?.leverage?.type;
      if (typeof raw === 'string') {
        const norm = raw.toLowerCase();
        if (norm === 'cross' || norm === 'isolated') return norm as 'cross' | 'isolated';
        if (norm === 'true' || norm === 'false') return norm === 'true' ? 'cross' : 'isolated';
        if (norm === '1' || norm === '0') return norm === '1' ? 'cross' : 'isolated';
      }
      if (typeof raw === 'number') {
        return raw > 0 ? 'cross' : 'isolated';
      }
      if (typeof raw === 'boolean') {
        return raw ? 'cross' : 'isolated';
      }
      if (posForOrder?.marginType === 'cross' || posForOrder?.marginType === 'isolated') {
        return posForOrder.marginType;
      }
      return null;
    },
    [],
  );

  /**
   * Keep layout transition for normal multi-row lists and also for the exact render where
   * the list shrinks (2->1, 1->0). This prevents survivor overlap/jumps while the removed
   * row is still fading out.
   */
  const positionRowLayout =
    !skipBookSwapRowAnim &&
    portfolioTab === 'positions' &&
    (filteredPositions.length > 1 || positionsJustShrank)
      ? ROW_LAYOUT_TRANSITION
      : undefined;
  const orderRowLayout =
    !skipBookSwapRowAnim &&
    portfolioTab === 'orders' &&
    (filteredOpenOrders.length > 1 || ordersJustShrank)
      ? ROW_LAYOUT_TRANSITION
      : undefined;

  const canShowPortfolioSkeleton =
    !filterSymbol && !bulkCloseActive && !bulkCancelActive;
  const parentPendingRowCount = parentPendingSignal
    ? Math.min(3, Math.max(1, pendingSkeletonRowCount, isSubmitting ? 1 : 0))
    : 0;
  const pendingSkeletonCount =
    canShowPortfolioSkeleton && holdPendingSkeleton
      ? Math.max(1, parentPendingRowCount)
      : 0;
  const showPositionsInitialSkeleton =
    canShowPortfolioSkeleton &&
    !!isInitialPortfolioLoading &&
    portfolioTab === 'positions' &&
    filteredPositions.length === 0 &&
    pendingSkeletonCount === 0;
  const showOrdersInitialSkeleton =
    canShowPortfolioSkeleton &&
    !!isInitialPortfolioLoading &&
    portfolioTab === 'orders' &&
    filteredOpenOrders.length === 0 &&
    pendingSkeletonCount === 0;
  const showHistoryInitialSkeleton =
    canShowPortfolioSkeleton &&
    !!isInitialPortfolioLoading &&
    portfolioTab === 'history' &&
    fills.length === 0 &&
    pendingSkeletonCount === 0;
  const appendPositionsSkeleton =
    portfolioTab === 'positions' && pendingSkeletonCount > 0;
  const appendOrdersSkeleton =
    portfolioTab === 'orders' && pendingSkeletonCount > 0;

  return (
    <LinearGradient
      colors={['#1a1a2e', '#16213e', '#0f0f1a']}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[styles.positionsCard, noHorizontalMargin && styles.positionsCardNoMargin]}
    >
      <View style={styles.positionsHeader}>
        <View style={styles.portfolioTabs}>
          <TouchableOpacity
            style={[styles.portfolioTab, portfolioTab === 'positions' && styles.portfolioTabActive]}
            onPress={() => onTabChange('positions')}
          >
            <Text style={[styles.portfolioTabText, portfolioTab === 'positions' && styles.portfolioTabTextActive]}>
              {t('portfolio.positions')} ({combinedPositions.length})
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.portfolioTab, portfolioTab === 'orders' && styles.portfolioTabActive]}
            onPress={() => onTabChange('orders')}
          >
            <Text style={[styles.portfolioTabText, portfolioTab === 'orders' && styles.portfolioTabTextActive]}>
              {t('portfolio.orders')} ({displayedOrdersCount})
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.portfolioTab, portfolioTab === 'history' && styles.portfolioTabActive]}
            onPress={() => onTabChange('history')}
          >
            <Text style={[styles.portfolioTabText, portfolioTab === 'history' && styles.portfolioTabTextActive]}>
              {t('portfolio.history')}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
      {actionsReadOnly && (portfolioTab === 'positions' || portfolioTab === 'orders') ? (
        <Text style={styles.readOnlyHint}>{t('portfolio.dedicatedBookReadonly')}</Text>
      ) : null}
      {portfolioTab === 'positions' && (effectiveCloseAll || availableSymbols.length > 0) && positions.length > 0 ? (
        <View style={[styles.headerActionsRow, isDemo && styles.headerActionsRowSplit]}>
          {/* Demo badge on the LEFT — pushes existing actions to the right
              by flipping justifyContent to space-between only when present.
              Mainnet behaviour unchanged. */}
          {isDemo ? <DemoBadge variant="compact" /> : null}
          <View style={styles.headerActionsRight}>
            {availableSymbols.length > 0 ? (
              <TouchableOpacity
                style={styles.filterButton}
                onPress={() => setShowFilterModal(true)}
              >
                <Ionicons name="filter" size={16} color={filterSymbol ? colors.accent.gold : colors.text.tertiary} />
              </TouchableOpacity>
            ) : null}
            {effectiveCloseAll ? (
              <TouchableOpacity
                style={styles.headerActionButton}
                onPress={() => setConfirmAction('close_all')}
                disabled={!!isCloseAllLoading || bulkCloseActive}
              >
                <Text style={styles.headerActionText}>{t('portfolio.closeAll')}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
      ) : null}
      {portfolioTab === 'orders' && (effectiveCancelAll || availableSymbols.length > 0) && openOrders.length > 0 ? (
        <View style={[styles.headerActionsRow, isDemo && styles.headerActionsRowSplit]}>
          {isDemo ? <DemoBadge variant="compact" /> : null}
          <View style={styles.headerActionsRight}>
            {availableSymbols.length > 0 ? (
              <TouchableOpacity
                style={styles.filterButton}
                onPress={() => setShowFilterModal(true)}
              >
                <Ionicons name="filter" size={16} color={filterSymbol ? colors.accent.gold : colors.text.tertiary} />
              </TouchableOpacity>
            ) : null}
            {effectiveCancelAll ? (
              <TouchableOpacity
                style={styles.headerActionButton}
                onPress={() => setConfirmAction('cancel_all')}
                disabled={!!isCancelAllLoading || bulkCancelActive}
              >
                <Text style={styles.headerActionText}>{t('portfolio.cancelAll')}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
      ) : null}

      {portfolioTab === 'positions' ? (
        filteredPositions.length === 0 ? (
          showPositionsInitialSkeleton ? (
            <PortfolioTabSkeleton variant="positions" count={2} />
          ) : pendingSkeletonCount > 0 ? (
            <PortfolioTabSkeleton variant="positions" count={pendingSkeletonCount} />
          ) : (
            <Text style={styles.positionsEmpty}>
              {filterSymbol ? t('portfolio.noPositionsForSymbol', { symbol: formatDisplaySymbol(filterSymbol) }) : t('portfolio.noOpenPositions')}
            </Text>
          )
        ) : (
          <>
          {displayedPositions.map((p: any, idx: number) => {
            const isSpotPosition = !!p?.isSpot || String(p?.coin ?? '').startsWith('@');
            const pnlNum = safeNum(p.unrealizedPnl);
            const roeNum = safeNum(p.returnOnEquity);
            const roePct = Number.isFinite(roeNum) ? roeNum * 100 : NaN;
            const sziNum = parseFloat(p.szi);
            const isLong = sziNum >= 0;
            const sideLabel = isLong ? t('trading.long') : t('trading.short');
            const sizeUnitsAbs = Number.isFinite(sziNum) ? Math.abs(sziNum) : 0;

            // Use per-position marginType if available, otherwise fall back to prop
            const posMarginMode: 'cross' | 'isolated' = p.marginType ?? marginMode;

            // Fetch live price
            let markPxNum = NaN;
            if (isSpotPosition) {
              // For spot, try multiple lookup strategies
              const coinPrice = getLivePrice(p.coin);
              const baseCoinPrice = p.baseCoin ? getLivePrice(p.baseCoin) : undefined;
              const spotSymbolPrice = p.spotSymbol ? getLivePrice(p.spotSymbol) : undefined;
              
              // Try base coin without "U" prefix (e.g., UETH -> ETH, UBTC -> BTC)
              // Many spot tokens have U-prefix but prices are under the perp symbol
              const baseCoinWithoutU = p.baseCoin?.startsWith('U') && p.baseCoin.length > 1 
                ? p.baseCoin.slice(1) 
                : undefined;
              const baseCoinWithoutUPrice = baseCoinWithoutU ? getLivePrice(baseCoinWithoutU) : undefined;
              
              const priceRaw = coinPrice || baseCoinPrice || spotSymbolPrice || baseCoinWithoutUPrice;
              markPxNum = priceRaw ? parseFloat(priceRaw) : safeNum(p.markPx);
            } else {
              const liveMarkRaw = liveAssetCtxs?.[String(p.coin)]?.markPx;
              // Perp PnL/mark must be mark-price based (HL defines
              // unrealized PnL with mark_price, not raw allMids). Use
              // activeAssetCtx.markPx from WS as the live source, with the
              // clearinghouse snapshot mark as a display fallback.
              markPxNum = liveMarkRaw ? parseFloat(liveMarkRaw) : safeNum(p.markPx);
            }
            const entryPxNum = safeNum(p.entryPx);
            const liqPxNum = p.liquidationPx ? safeNum(p.liquidationPx) : NaN;
            const posValueUsd = Number.isFinite(markPxNum) ? sizeUnitsAbs * markPxNum : NaN;
            const spotCloseSize = isSpotPosition
              ? safeNum(p.availableSizeUnits ?? p.szi)
              : NaN;
            const spotMinLot = isSpotPosition ? safeNum(p?.minLot) : NaN;
            // Spot positions are only sellable if the free balance is at or
            // above the asset's szDecimals lot floor. Otherwise the order
            // would just throw "Size too small" inside formatSize.
            const canCloseSpotPosition =
              !isSpotPosition ||
              (Number.isFinite(spotCloseSize) &&
                spotCloseSize > 0 &&
                (!Number.isFinite(spotMinLot) || spotMinLot <= 0 || spotCloseSize >= spotMinLot));
            // Extract leverage value from object or direct number
            const levObj = p.leverage;
            const rawLev = typeof levObj === 'object' && levObj?.value != null
              ? safeNum(levObj.value)
              : safeNum(levObj ?? p.positionLeverage);
            const marginUsed = safeNum(p.marginUsed ?? p.marginUsedUsd ?? p.positionMargin ?? p?.marginUsed ?? p?.marginUsedUsd);
            const levFromMargin = Number.isFinite(marginUsed) && marginUsed > 0 && Number.isFinite(posValueUsd) ? posValueUsd / marginUsed : NaN;
            const levNum = Number.isFinite(rawLev) && rawLev > 0 ? rawLev : levFromMargin;
            const levLabel = !isSpotPosition && Number.isFinite(levNum) ? `${Math.max(1, Math.round(levNum))}x` : null;

            // ─── LIVE PnL re-derivation ──────────────────────────────────
            // `p.unrealizedPnl` / `p.returnOnEquity` come from HL's
            // clearinghouseState snapshot (allDexsClearinghouseState WS).
            // HL only pushes that stream on account-state events — fills,
            // funding ticks, liquidations, margin recalcs — NOT on every
            // mid-price tick. In a quiet market the snapshot PnL can lag the
            // chart by many seconds, which caused a real-world case where a
            // trader saw green, tapped Close, and HL settled at a now-red
            // price. HL's own UI sidesteps this by deriving displayed PnL
            // client-side from live mid/mark × signed size − entry × size,
            // and keeping the snapshot only as a fallback.
            //
            // `markPxNum` above comes from activeAssetCtx.markPx (live WS),
            // so the recompute follows HL's documented mark-price PnL:
            //   livePnl        = (markPx − entryPx) × szi     (szi signed: long>0, short<0)
            //   liveRoePct     = livePnl / marginUsed × 100
            //   liveSpotPct    = (markPx − entryPx) / entryPx × 100
            const liveSignedPnl =
              Number.isFinite(markPxNum) && Number.isFinite(entryPxNum) && Number.isFinite(sziNum)
                ? (markPxNum - entryPxNum) * sziNum
                : NaN;

            // Spot recompute keeps its original absolute-size form (no short
            // side), which is equivalent to `liveSignedPnl` for long-only spot.
            const currentPnlNum = isSpotPosition
              ? (Number.isFinite(markPxNum) && Number.isFinite(entryPxNum) && entryPxNum > 0 && Number.isFinite(sizeUnitsAbs)
                  ? (markPxNum - entryPxNum) * sizeUnitsAbs
                  : pnlNum)
              : (Number.isFinite(liveSignedPnl) ? liveSignedPnl : NaN);

            // Live ROE for perps; falls back to the snapshot's returnOnEquity
            // when live inputs aren't ready yet (first frame after mount, or
            // HIP-3 asset without a live mid).
            const livePerpRoePct =
              !isSpotPosition &&
              Number.isFinite(liveSignedPnl) &&
              Number.isFinite(marginUsed) &&
              marginUsed > 0
                ? (liveSignedPnl / marginUsed) * 100
                : NaN;

            const effectivePnlNum = currentPnlNum;
            const effectiveRoePct = !isSpotPosition
              ? (Number.isFinite(livePerpRoePct) ? livePerpRoePct : NaN)
              : NaN;

            const pnlColor = Number.isFinite(effectivePnlNum) ? (effectivePnlNum >= 0 ? colors.status.success : colors.status.error) : colors.text.primary;
            const pnlPercentForShare = isSpotPosition
              ? (Number.isFinite(entryPxNum) && entryPxNum > 0 && Number.isFinite(markPxNum))
                  ? ((markPxNum - entryPxNum) / entryPxNum) * 100
                  : 0
              : (Number.isFinite(effectiveRoePct) ? effectiveRoePct : 0);
            const spotPnlPercent = isSpotPosition && Number.isFinite(entryPxNum) && entryPxNum > 0 && Number.isFinite(markPxNum)
              ? ((markPxNum - entryPxNum) / entryPxNum) * 100
              : NaN;
            const tpslReady =
              Number.isFinite(entryPxNum) &&
              Number.isFinite(markPxNum) &&
              Number.isFinite(sizeUnitsAbs) &&
              sizeUnitsAbs > 0;

            const renderRowKey = positionRenderKey(p);
            const isSingleCloseProcessing = closingKeyMatchesPosition(effectiveClosingPositionKey, p);
            const isBulkCloseProcessing =
              !!isCloseAllLoading ||
              (bulkCloseActive && bulkCloseSnapshotRef.current.has(renderRowKey));
            const posProcessing =
              isSingleCloseProcessing ||
              isBulkCloseProcessing;
            const disablePositionActions =
              isSubmitting || effectiveCancelingOrderId !== null || posProcessing;
            const positionRowExiting =
              skipBookSwapRowAnim
                ? undefined
                : filteredPositions.length > 1
                  ? rowExitForIndex(idx, isBulkCloseProcessing)
                  : undefined;
            const matchedAiPos = !isSpotPosition
              ? findAiPositionForLive({
                  aiByCoin: aiPosByCoin,
                  coin: String(p.coin ?? ''),
                  szi: sziNum,
                  entryPx: entryPxNum,
                  dedicatedScope: !!aiScopeAgentId,
                })
              : undefined;

            return (
              <ProcessingRow
                key={renderRowKey}
                layout={positionRowLayout}
                exiting={positionRowExiting}
                isProcessing={posProcessing}
              >
                <View style={styles.positionContent}>
                  <View style={styles.positionLeft}>
                    <View style={styles.positionTop}>
                      <View style={styles.positionTitleRow}>
                        {matchedAiPos ? (
                          <TouchableOpacity
                            style={styles.aiAgentNav}
                            onPress={() => pushRouteOnce(router, '/ai-agents')}
                            activeOpacity={0.7}
                            hitSlop={6}
                          >
                            <MaterialCommunityIcons name="robot-outline" size={13} color={colors.accent.gold} />
                            <Ionicons name="chevron-forward" size={10} color={colors.text.tertiary} />
                          </TouchableOpacity>
                        ) : null}
                        {showAssetNavForCoin(String(p.coin ?? ''), isSpotPosition) ? (
                          <TouchableOpacity style={styles.symbolBadgeNav} onPress={() => navigateToAsset(p.coin, { isSpot: isSpotPosition })} activeOpacity={0.6}>
                            <Text style={styles.symbolBadgeText}>{formatDisplaySymbol(p.coin)}</Text>
                            <Ionicons name="chevron-forward" size={10} color={colors.text.tertiary} />
                          </TouchableOpacity>
                        ) : (
                          <View style={styles.symbolBadge}>
                            <Text style={styles.symbolBadgeText}>{formatDisplaySymbol(p.coin)}</Text>
                          </View>
                        )}
                        {levLabel ? <MetaBadge label={levLabel} /> : null}
                        {isSpotPosition ? (
                          <MetaBadge label={t('trading.spot')} />
                        ) : showMarginMode ? (
                          <MetaBadge
                            label={posMarginMode === 'cross' ? t('trading.cross') : t('trading.isolated')}
                          />
                        ) : null}
                        <View style={[styles.sidePill, isLong ? styles.sidePillLong : styles.sidePillShort]}>
                          <Text style={[styles.sidePillText, isLong ? styles.sidePillTextLong : styles.sidePillTextShort]}>
                            {isSpotPosition ? (isLong ? t('trading.buy') : t('trading.sell')) : sideLabel}
                          </Text>
                        </View>
                      </View>
                    </View>

                    <View style={styles.metricsGrid}>
                      <View style={styles.metricColumn}>
                        <View style={styles.metricItem}>
                          <Text style={styles.metricLabel}>{t('portfolio.entry')}</Text>
                          <Text style={styles.metricValue}>{formatPriceNum(entryPxNum)}</Text>
                        </View>
                        {isSpotPosition ? (
                          <View style={styles.metricItem}>
                            <View style={styles.metricLabelRow}>
                              <Text style={styles.metricLabel}>{t('portfolio.pnl')}</Text>
                              <TouchableOpacity
                                style={styles.metricInlineButton}
                                onPress={() => {
                                  if (!Number.isFinite(entryPxNum) || !Number.isFinite(markPxNum)) {
                                    showToast(t('errors.positionDataNotReady'));
                                    return;
                                  }
                                  onSharePositionPnl({
                                    symbol: formatDisplaySymbol(String(p.coin)),
                                    direction: isLong ? 'LONG' : 'SHORT',
                                    pnlPercent: pnlPercentForShare,
                                    entryPrice: entryPxNum,
                                    markPrice: markPxNum,
                                    leverage: undefined,
                                  });
                                }}
                                disabled={pnlShareLoading}
                              >
                                <Ionicons name="share-social-outline" size={12} color={colors.accent.gold} />
                              </TouchableOpacity>
                            </View>
                            <Text style={[styles.metricValue, { color: pnlColor }]}>
                              {Number.isFinite(effectivePnlNum) ? formatPnlDisplay(effectivePnlNum) : '--'}
                            </Text>
                            {Number.isFinite(effectivePnlNum) && Number.isFinite(spotPnlPercent) && (
                              <Text style={[styles.metricPct, { color: pnlColor }]}>
                                {spotPnlPercent >= 0 ? '+' : ''}{spotPnlPercent.toFixed(2)}%
                              </Text>
                            )}
                          </View>
                        ) : (
                          <>
                            <View style={styles.metricItem}>
                              <Text style={styles.metricLabel}>{t('portfolio.liq')}</Text>
                              <Text style={styles.metricValue}>{Number.isFinite(liqPxNum) && liqPxNum > 0 ? formatPriceNum(liqPxNum) : 'N/A'}</Text>
                            </View>
                            <View style={styles.metricItem}>
                              <Text style={styles.metricLabel}>{t('portfolio.qty')}</Text>
                              <Text style={styles.metricValue}>
                                {(() => {
                                  const raw = parseFloat(p.szi ?? '0');
                                  if (!Number.isFinite(raw)) return '--';
                                  const abs = Math.abs(raw);
                                  return abs.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 8 });
                                })()}
                              </Text>
                            </View>
                            <View style={styles.metricItem}>
                              <View style={styles.metricLabelRow}>
                                <Text style={styles.metricLabel}>{t('portfolio.pnl')}</Text>
                                <TouchableOpacity
                                  style={styles.metricInlineButton}
                                  onPress={() => {
                                    if (!Number.isFinite(entryPxNum) || !Number.isFinite(markPxNum)) {
                                      showToast(t('errors.positionDataNotReady'));
                                      return;
                                    }
                                    onSharePositionPnl({
                                      symbol: formatDisplaySymbol(String(p.coin)),
                                      direction: isLong ? 'LONG' : 'SHORT',
                                      pnlPercent: pnlPercentForShare,
                                      entryPrice: entryPxNum,
                                      markPrice: markPxNum,
                                      leverage: Number.isFinite(levNum) ? Math.max(1, Math.round(levNum)) : undefined,
                                    });
                                  }}
                                  disabled={pnlShareLoading}
                                >
                                  <Ionicons name="share-social-outline" size={12} color={colors.accent.gold} />
                                </TouchableOpacity>
                              </View>
                              <Text style={[styles.metricValue, { color: pnlColor }]}>
                                {Number.isFinite(effectivePnlNum) ? formatPnlDisplay(effectivePnlNum) : (p.unrealizedPnl ?? '--')}
                              </Text>
                              {Number.isFinite(effectivePnlNum) && Number.isFinite(effectiveRoePct) && (
                                <Text style={[styles.metricPct, { color: pnlColor }]}>
                                  {effectiveRoePct >= 0 ? '+' : ''}{effectiveRoePct.toFixed(2)}%
                                </Text>
                              )}
                            </View>
                          </>
                        )}
                      </View>
                      <View style={styles.metricColumn}>
                        <View style={styles.metricItem}>
                          <Text style={styles.metricLabel}>{t('portfolio.mark')}</Text>
                          <Text style={styles.metricValue}>{formatPriceNum(markPxNum)}</Text>
                        </View>
                        <View style={styles.metricItem}>
                          <Text style={styles.metricLabel}>{t('portfolio.value')}</Text>
                          <Text style={styles.metricValue}>{formatPriceNum(posValueUsd)}</Text>
                        </View>
                        {!isSpotPosition && p.cumFunding != null ? (() => {
                          // HL's `cumFunding.sinceOpen` is the amount of funding
                          // PAID by the position since it was last opened
                          // (positive = cost to user, negative = received by
                          // user). HL's UI and public explorers display this
                          // from the user's perspective (positive = your gain,
                          // negative = your cost), so we flip the sign here to
                          // stay consistent with what users see elsewhere.
                          const fundingPaid = parseFloat(p.cumFunding?.sinceOpen ?? '0');
                          const fundingForUser = -fundingPaid;
                          const fundingColor = fundingForUser > 0 ? colors.status.success : fundingForUser < 0 ? colors.status.error : colors.text.secondary;
                          return (
                            <View style={styles.metricItem}>
                              <Text style={styles.metricLabel}>{t('portfolio.funding')}</Text>
                              <Text style={[styles.metricValue, { color: fundingColor }]}>
                                {formatPnlDisplay(fundingForUser)}
                              </Text>
                            </View>
                          );
                        })() : null}
                        {!isSpotPosition ? (
                          <View style={styles.metricItem}>
                            <Text style={styles.metricLabel}>{t('portfolio.marginUsed')}</Text>
                            <Text style={styles.metricValue}>
                              {Number.isFinite(marginUsed) ? formatPriceNum(marginUsed) : '--'}
                            </Text>
                          </View>
                        ) : null}
                      </View>
                    </View>
                  </View>

                  <View style={styles.positionActions}>
                    {!actionsReadOnly && (isSingleCloseProcessing || isBulkCloseProcessing) ? (
                      <ActivityIndicator size="small" color={colors.accent.gold} />
                    ) : null}
                    {!actionsReadOnly && !(isSingleCloseProcessing || isBulkCloseProcessing) ? (
                      <TouchableOpacity
                        style={styles.positionActionButton}
                        onPress={() => {
                          const payload = {
                            coin: String(p.coin),
                            szi: String(isSpotPosition ? spotCloseSize : p.szi),
                          };
                          if (isSpotPosition) {
                            setConfirmClosePosition(payload);
                            return;
                          }
                          sharedAiGuard(() => setConfirmClosePosition(payload), payload.coin);
                        }}
                        disabled={disablePositionActions || !canCloseSpotPosition}
                      >
                        <Text style={styles.positionActionText}>{t('portfolio.closePosition')}</Text>
                      </TouchableOpacity>
                    ) : null}
                    {!actionsReadOnly && !isSpotPosition ? (
                      <TouchableOpacity
                        style={[
                          styles.positionActionButton,
                          (!tpslReady || disablePositionActions) && styles.positionActionButtonDisabled,
                        ]}
                        onPress={() => {
                          if (!tpslReady) {
                            showToast(t('errors.positionDataNotReady'));
                            return;
                          }
                          onOpenTpsl({
                            coin: String(p.coin),
                            entrySide: isLong ? 'long' : 'short',
                            entryPx: entryPxNum,
                            markPx: markPxNum,
                            sizeUnits: sizeUnitsAbs,
                            marginUsedUsd: Number.isFinite(marginUsed) && marginUsed > 0 ? marginUsed : undefined,
                            leverage: Number.isFinite(levNum) && levNum > 0 ? levNum : undefined,
                          });
                        }}
                        disabled={!tpslReady || disablePositionActions}
                      >
                        <Text style={styles.positionActionText}>{t('trading.tpSl')}</Text>
                      </TouchableOpacity>
                    ) : null}
                    {matchedAiPos ? (
                        <TouchableOpacity
                          style={styles.positionActionButton}
                          onPress={() =>
                            setReasoningModal({
                              agentId: matchedAiPos.agentId,
                              agentName: matchedAiPos.agentName,
                              symbol: matchedAiPos.symbol,
                              direction: matchedAiPos.direction,
                              openedAt: matchedAiPos.openedAt,
                            })
                          }
                        >
                          <Text style={styles.positionActionText}>
                            {t('aiAgents.reasoning')}
                          </Text>
                        </TouchableOpacity>
                    ) : null}
                  </View>
                </View>
              </ProcessingRow>
            );
          })}
          {appendPositionsSkeleton ? (
            <PortfolioTabSkeleton variant="positions" count={pendingSkeletonCount} />
          ) : null}
          {positionsRemaining > 0 ? (
            <TouchableOpacity
              style={styles.viewAllHistoryButton}
              onPress={() => setPositionsVisibleCount((n) => n + LIST_PAGE_SIZE)}
              activeOpacity={0.7}
            >
              <Text style={styles.viewAllHistoryText}>
                {t('tradeHistory.showMoreRemaining', { count: positionsRemaining })}
              </Text>
              <Ionicons name="chevron-down" size={14} color={colors.accent.gold} />
            </TouchableOpacity>
          ) : null}
          </>
        )
      ) : portfolioTab === 'orders' ? (
        filteredOpenOrders.length === 0 ? (
          showOrdersInitialSkeleton ? (
            <PortfolioTabSkeleton variant="orders" count={2} />
          ) : pendingSkeletonCount > 0 ? (
            <PortfolioTabSkeleton variant="orders" count={pendingSkeletonCount} />
          ) : (
            <Text style={styles.positionsEmpty}>
              {filterSymbol ? t('portfolio.noOrdersForSymbol', { symbol: filterSymbol }) : t('portfolio.noOpenOrders')}
            </Text>
          )
        ) : (
          <>
          {displayedOpenOrders.map((o: any, idx: number) => {
            const order = o?.order ?? o?.o ?? o;
            const orderCoin = String(order?.coin ?? o?.coin ?? '');
            const isSpotOrder = orderCoin.startsWith('@') || !!(order?.isSpot ?? o?.isSpot);
            const orderSide = order?.side ?? o?.side;
            const orderSz = order?.sz ?? o?.sz;
            const orderLimitPx =
              order?.limitPx ??
              order?.orderType?.limitPx ??
              order?.limitPrice ??
              order?.p ??
              order?.px ??
              order?.price ??
              o?.limitPx ??
              o?.p ??
              o?.order?.limitPx ??
              o?.order?.p;
            const szNumRaw = parseFloat(orderSz);
            const limitPxNum = orderLimitPx ? parseFloat(orderLimitPx) : NaN;

            // Detect TP/SL trigger orders early — they have size 0 meaning "close full position"
            const orderTpsl = order?.tpsl ?? o?.tpsl;
            const orderTriggerPx = order?.triggerPx ?? o?.triggerPx;
            const isTpSlOrder =
              orderTpsl === 'tp' ||
              orderTpsl === 'sl' ||
              (orderTriggerPx != null && parseFloat(orderTriggerPx) > 0);

            // For TP/SL with size 0 → fall back to the associated position size
            const posForOrderEarly = isTpSlOrder
              ? findPositionForSymbol(filteredPositions, orderCoin)
              : null;
            const szNum =
              isTpSlOrder && (szNumRaw === 0 || !Number.isFinite(szNumRaw)) && posForOrderEarly
                ? Math.abs(parseFloat(posForOrderEarly?.szi ?? '0'))
                : szNumRaw;

            const lp = orderCoin ? getLivePrice(orderCoin) : undefined;
            const markPxNum = lp
              ? parseFloat(lp)
              : orderCoin === currentAssetSymbol
                ? parseFloat(currentAssetMarkPx || '0')
                : NaN;
            const pxForValue = Number.isFinite(limitPxNum) ? limitPxNum : markPxNum;
            const orderValueUsd = Number.isFinite(szNum) && Number.isFinite(pxForValue) ? Math.abs(szNum) * pxForValue : NaN;
            const sideLabel = orderSide === 'B' ? t('trading.buy') : t('trading.sell');
            const isBuy = orderSide === 'B';
            const orderTypeRaw = order?.orderType ?? o?.orderType;
            const orderTypeLabel =
              typeof orderTypeRaw === 'string'
                ? orderTypeRaw
                : orderTypeRaw?.limit
                  ? 'Limit'
                  : orderTypeRaw?.trigger
                    ? 'Trigger'
                    : '';
            const parsedTriggerPx = parseFloat(order?.triggerPx ?? o?.triggerPx ?? '');
            const isTriggerFlag =
              (order?.isTrigger ?? o?.isTrigger) === true ||
              (Number.isFinite(parsedTriggerPx) && parsedTriggerPx > 0) ||
              orderTypeRaw?.trigger != null;
            // Allow edit for limit orders (valid limit price) or trigger/TP-SL orders (valid trigger price).
            const parsedTriggerPxVal = parseFloat(orderTriggerPx ?? '');
            const isLimitOrder =
              Number.isFinite(limitPxNum) &&
              !isTriggerFlag &&
              (orderTypeLabel === '' || orderTypeLabel.toLowerCase().includes('limit'));
            const isEditableOrder = isLimitOrder || (isTriggerFlag && Number.isFinite(parsedTriggerPxVal) && parsedTriggerPxVal > 0);
            const reduceOnly = !!(
              order?.reduceOnly ??
              order?.isReduce ??
              order?.r ??
              order?.orderType?.reduceOnly ??
              order?.t?.reduceOnly
            );
            const cloid = order?.cloid ?? order?.c ?? o?.cloid ?? o?.c ?? null;
            const posForOrder = findPositionForSymbol(filteredPositions, orderCoin);
            const orderMarginMode = getOrderMarginMode(order, posForOrder);
            const active = orderCoin ? activeAssetData?.[orderCoin] : null;
            const activeLev = active?.leverage;
            const activeLevValue =
              typeof activeLev === 'object' && activeLev?.value != null ? safeNum(activeLev.value) : safeNum(activeLev);
            const activeMarginMode =
              typeof activeLev === 'object' && (activeLev.type === 'cross' || activeLev.type === 'isolated')
                ? (activeLev.type as 'cross' | 'isolated')
                : null;
            const displayMarginMode = orderMarginMode ?? activeMarginMode ?? posForOrder?.marginType ?? null;
            const posLevInfo = (() => {
              if (!posForOrder) return { num: NaN, label: null };
              const levObj = posForOrder?.leverage;
              const rawLev =
                typeof levObj === 'object' && levObj?.value != null
                  ? safeNum(levObj.value)
                  : safeNum(levObj ?? posForOrder?.positionLeverage);
              const marginUsed = safeNum(posForOrder?.marginUsed ?? posForOrder?.marginUsedUsd ?? posForOrder?.positionMargin);
              const posSziNum = safeNum(posForOrder?.szi);
              const posValueUsd = Number.isFinite(markPxNum) && Number.isFinite(posSziNum) ? Math.abs(posSziNum) * markPxNum : NaN;
              const levFromMargin =
                Number.isFinite(marginUsed) && marginUsed > 0 && Number.isFinite(posValueUsd)
                  ? posValueUsd / marginUsed
                  : NaN;
              const levNum = Number.isFinite(rawLev) && rawLev > 0 ? rawLev : levFromMargin;
              return {
                num: levNum,
                label: Number.isFinite(levNum) ? `${Math.max(1, Math.round(levNum))}x` : null,
              };
            })();
            const orderLevRaw = (() => {
              const raw =
                typeof order?.leverage === 'object' && order?.leverage?.value != null
                  ? safeNum(order.leverage.value)
                  : safeNum(
                      order?.leverage ??
                        order?.leverage?.value ??
                        order?.t?.leverage ??
                        order?.t?.leverage?.value ??
                        order?.orderType?.leverage ??
                        order?.orderType?.leverage?.value,
                    );
              return Number.isFinite(raw) && raw > 0 ? raw : NaN;
            })();
            const directMarginRaw =
              order?.marginUsed ??
              order?.marginUsedUsd ??
              order?.initialMargin ??
              order?.orderType?.marginUsed ??
              order?.orderType?.marginUsedUsd ??
              order?.t?.marginUsed;
            const hasDirectMargin =
              order?.marginUsed != null ||
              order?.marginUsedUsd != null ||
              order?.initialMargin != null ||
              order?.orderType?.marginUsed != null ||
              order?.orderType?.marginUsedUsd != null ||
              order?.t?.marginUsed != null;
            const orderMarginUsd = (() => {
              const direct = safeNum(directMarginRaw);
              if (hasDirectMargin && Number.isFinite(direct)) return direct;
              const levForMargin = Number.isFinite(orderLevRaw) ? orderLevRaw : posLevInfo.num;
              if (Number.isFinite(orderValueUsd) && Number.isFinite(levForMargin) && levForMargin > 0) {
                return orderValueUsd / levForMargin;
              }
              return NaN;
            })();
            const directLevLabel = Number.isFinite(orderLevRaw) ? `${Math.max(1, Math.round(orderLevRaw))}x` : null;
            const levFromMargin =
              Number.isFinite(orderMarginUsd) && orderMarginUsd > 0 && Number.isFinite(orderValueUsd)
                ? orderValueUsd / orderMarginUsd
                : NaN;
            const levLabel = isSpotOrder
              ? null
              : directLevLabel ??
                posLevInfo.label ??
                (Number.isFinite(activeLevValue) ? `${Math.max(1, Math.round(activeLevValue))}x` : null) ??
                (Number.isFinite(levFromMargin) ? `${Math.max(1, Math.round(levFromMargin))}x` : null);
            const orderOid = Number(o.oid ?? order?.oid);
            const orderRowKey = Number.isFinite(orderOid) ? `order:${orderCoin}:${orderOid}` : `order:${orderCoin}:${String(o.oid ?? order?.oid ?? '')}`;
            const canCancelOrder = Number.isFinite(orderOid);
            const isSingleCancelProcessing = effectiveCancelingOrderId === orderOid;
            const isBulkCancelProcessing =
              !!isCancelAllLoading ||
              (bulkCancelActive && Number.isFinite(orderOid) && bulkCancelSnapshotRef.current.has(orderOid));
            const orderProcessing = isSingleCancelProcessing || isBulkCancelProcessing;
            const disableOrderActions =
              isSubmitting || effectiveClosingPositionKey !== null || orderProcessing;
            const orderRowExiting =
              skipBookSwapRowAnim
                ? undefined
                : filteredOpenOrders.length > 1
                  ? rowExitForIndex(idx, isBulkCancelProcessing)
                  : undefined;

            return (
              <ProcessingRow
                key={orderRowKey}
                layout={orderRowLayout}
                exiting={orderRowExiting}
                isProcessing={orderProcessing}
              >
                <View style={styles.positionContent}>
                  <View style={styles.positionLeft}>
                    <View style={styles.positionTop}>
                      <View style={styles.positionTitleRow}>
                        {!isSpotOrder &&
                        posForOrder &&
                        findAiPositionForLive({
                          aiByCoin: aiPosByCoin,
                          coin: String(orderCoin ?? ''),
                          szi: safeNum(posForOrder?.szi),
                          entryPx: safeNum(posForOrder?.entryPx ?? posForOrder?.entryPrice),
                          dedicatedScope: !!aiScopeAgentId,
                        }) ? (
                          <TouchableOpacity
                            style={styles.aiAgentNav}
                            onPress={() => pushRouteOnce(router, '/ai-agents')}
                            activeOpacity={0.7}
                            hitSlop={6}
                          >
                            <MaterialCommunityIcons name="robot-outline" size={13} color={colors.accent.gold} />
                            <Ionicons name="chevron-forward" size={10} color={colors.text.tertiary} />
                          </TouchableOpacity>
                        ) : null}
                        {showAssetNavForCoin(orderCoin, isSpotOrder) ? (
                          <TouchableOpacity style={styles.symbolBadgeNav} onPress={() => navigateToAsset(orderCoin, { isSpot: isSpotOrder })} activeOpacity={0.6}>
                            <Text style={styles.symbolBadgeText}>{formatDisplaySymbol(orderCoin)}</Text>
                            <Ionicons name="chevron-forward" size={10} color={colors.text.tertiary} />
                          </TouchableOpacity>
                        ) : (
                          <View style={styles.symbolBadge}>
                            <Text style={styles.symbolBadgeText}>{formatDisplaySymbol(orderCoin)}</Text>
                          </View>
                        )}
                        {levLabel ? <MetaBadge label={levLabel} /> : null}
                        {isSpotOrder ? (
                          <MetaBadge label={t('trading.spot')} />
                        ) : showMarginMode && displayMarginMode ? (
                          <MetaBadge
                            label={displayMarginMode === 'cross' ? t('trading.cross') : t('trading.isolated')}
                          />
                        ) : null}
                        <View style={[styles.sidePill, isBuy ? styles.sidePillLong : styles.sidePillShort]}>
                          <Text style={[styles.sidePillText, isBuy ? styles.sidePillTextLong : styles.sidePillTextShort]}>{sideLabel}</Text>
                        </View>
                      </View>
                    </View>
                    <View style={styles.metricsGrid}>
                      <View style={styles.metricColumn}>
                        <View style={styles.metricItem}>
                          <Text style={styles.metricLabel}>
                            {isTpSlOrder && orderTriggerPx ? t('trading.triggerPrice') ?? 'Trigger' : t('trading.price')}
                          </Text>
                          <Text style={styles.metricValue}>
                            {isTpSlOrder && orderTriggerPx
                              ? formatPrice(String(orderTriggerPx))
                              : orderLimitPx ? formatPrice(String(orderLimitPx)) : '--'}
                          </Text>
                        </View>
                        <View style={styles.metricItem}>
                          <Text style={styles.metricLabel}>{t('trading.size')}</Text>
                          <Text style={styles.metricValue}>
                            {Number.isFinite(szNum) && szNum > 0 ? szNum.toFixed(4) : orderSz ?? '--'}
                          </Text>
                        </View>
                      </View>
                      <View style={styles.metricColumn}>
                        <View style={styles.metricItem}>
                          <Text style={styles.metricLabel}>{t('trading.orderValue')}</Text>
                          <Text style={styles.metricValue}>{Number.isFinite(orderValueUsd) ? formatPriceNum(orderValueUsd) : '--'}</Text>
                        </View>
                      </View>
                    </View>
                  </View>
                  <View style={styles.positionActions}>
                    {!actionsReadOnly && orderProcessing ? (
                      <ActivityIndicator size="small" color={colors.accent.gold} />
                    ) : null}
                    {!actionsReadOnly && !orderProcessing ? (
                      <TouchableOpacity
                        style={[
                          styles.positionActionButton,
                          (!canCancelOrder || disableOrderActions) && styles.positionActionButtonDisabled,
                        ]}
                        onPress={() => {
                          if (!canCancelOrder) return;
                          setOptimisticCancelingOrderId(orderOid);
                          onCancelOrder(orderCoin, orderOid);
                        }}
                        disabled={!canCancelOrder || disableOrderActions}
                      >
                        <Text style={styles.positionActionText}>{t('portfolio.cancelOrder')}</Text>
                      </TouchableOpacity>
                    ) : null}
                    {!actionsReadOnly && ENABLE_ORDER_EDIT && onModifyOrder ? (
                      <TouchableOpacity
                        style={[
                          styles.positionActionButton,
                          (!isEditableOrder || !canCancelOrder || disableOrderActions) &&
                            styles.positionActionButtonDisabled,
                        ]}
                        onPress={() => {
                          if (!isEditableOrder) {
                            showToast(t('errors.onlyLimitOrdersEditable'));
                            return;
                          }
                          const isTriggerEdit = isTriggerFlag && Number.isFinite(parsedTriggerPxVal) && parsedTriggerPxVal > 0;
                          setEditLimitPxText(isTriggerEdit ? formatPriceNum(parsedTriggerPxVal) : formatPriceNum(limitPxNum));
                          setEditSizeText(Number.isFinite(szNum) && szNum > 0 ? String(szNum) : String(orderSz ?? ''));
                          setEditOrderError(null);
                          setEditOrderModal({
                            symbol: String(orderCoin),
                            oid: orderOid,
                            side: isBuy ? 'buy' : 'sell',
                            sizeUnits: String(orderSz ?? ''),
                            referencePx: Number.isFinite(markPxNum) ? markPxNum : undefined,
                            isSpot: isSpotOrder,
                            reduceOnly,
                            cloid,
                            isTrigger: isTriggerEdit,
                            tpsl: orderTpsl === 'tp' || orderTpsl === 'sl' ? orderTpsl : undefined,
                          });
                        }}
                        disabled={!canCancelOrder || disableOrderActions}
                      >
                        <Text style={styles.positionActionText}>{t('common.edit')}</Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                </View>
              </ProcessingRow>
            );
          })}
          {appendOrdersSkeleton ? (
            <PortfolioTabSkeleton variant="orders" count={pendingSkeletonCount} />
          ) : null}
          {ordersRemaining > 0 ? (
            <TouchableOpacity
              style={styles.viewAllHistoryButton}
              onPress={() => setOrdersVisibleCount((n) => n + LIST_PAGE_SIZE)}
              activeOpacity={0.7}
            >
              <Text style={styles.viewAllHistoryText}>
                {t('tradeHistory.showMoreRemaining', { count: ordersRemaining })}
              </Text>
              <Ionicons name="chevron-down" size={14} color={colors.accent.gold} />
            </TouchableOpacity>
          ) : null}
          </>
        )
      ) : fills.length === 0 ? (
        showHistoryInitialSkeleton ? (
          <PortfolioTabSkeleton variant="history" count={2} />
        ) : (
          <Text style={styles.positionsEmpty}>{t('tradeHistory.noTradeHistory')}</Text>
        )
      ) : (
        <>
          {displayedFills.map((f: any, idx: number) => {
            const coin = String(f.coin ?? f.symbol ?? f.asset ?? '--');
            const isSpotFill = coin.startsWith('@') || !!(f?.isSpot);
            const sideRaw = String(f.side ?? f.dir ?? f.orderSide ?? '').toLowerCase();
            const isBuy = sideRaw === 'b' || sideRaw === 'buy' || sideRaw === 'long';
            const sideLabel = sideRaw ? (isBuy ? t('trading.buy') : t('trading.sell')) : '--';
            const pxNum = safeNum(f.px ?? f.price ?? f.fillPx);
            const szNum = safeNum(f.sz ?? f.size ?? f.qty);
            // Extract fee - check multiple possible field names and structures
            // For spot fills, fee might be in different locations or nested structures
            // Note: For buy orders, fee is in the asset token (e.g., UETH), not USD
            // For sell orders, fee is in USDC
            let feeNum = NaN;
            // Try direct fee fields first
            const directFee = f.fee ?? f.feeUsd ?? f.fees ?? f.feeAmount ?? f.feeAmt ?? f.feeValue ?? f.feePaid;
            if (directFee != null) {
              feeNum = safeNum(directFee);
            }
            // Try nested fee structures
            if (!Number.isFinite(feeNum)) {
              const nestedFee = f.closedPnl?.fee ?? f.closedPnl?.feeUsd ?? f.fee?.fee ?? f.fee?.feeUsd ?? f.fee?.amount ?? f.fee?.value;
              if (nestedFee != null) {
                feeNum = safeNum(nestedFee);
              }
            }
            // For spot fills, try additional field names that might be used
            if (!Number.isFinite(feeNum) && isSpotFill) {
              const spotFee = (f as any).spotFee ?? (f as any).spotFeeUsd ?? (f as any).order?.fee ?? (f as any).fill?.fee ?? (f as any).spot?.fee;
              if (spotFee != null) {
                feeNum = safeNum(spotFee);
              }
            }
            
            // Convert fee to USD if it's in a token (e.g., UETH for buy orders)
            // Sell orders have fee in USDC, buy orders have fee in the asset token
            if (Number.isFinite(feeNum) && isSpotFill && f.feeToken && f.feeToken !== 'USDC') {
              // Fee is in the asset token, convert to USD by multiplying by price
              if (Number.isFinite(pxNum)) {
                feeNum = feeNum * pxNum;
              }
            }
            const pnlNum = safeNum(
              f.pnl ?? f.realizedPnl ?? f.pnlUsd ?? f.closedPnl ?? f.realizedPnlUsd ?? f.pnlValue,
            );
            // HL fills separate fee from pnl; show net PnL so opens aren't misleadingly 0.
            const netPnlNum = Number.isFinite(pnlNum)
              ? pnlNum - (Number.isFinite(feeNum) ? feeNum : 0)
              : (Number.isFinite(feeNum) ? -feeNum : NaN);
            const timeStr = formatShortTime(f.time ?? f.timestamp);
            const tradeValueUsd = Number.isFinite(pxNum) && Number.isFinite(szNum) ? Math.abs(pxNum * szNum) : NaN;
            const rowKey = f.oid ?? f.tid ?? `${coin}:${f.time ?? 't'}:${idx}`;
            const pnlPercentForShare = Number.isFinite(netPnlNum) && Number.isFinite(tradeValueUsd) && tradeValueUsd > 0
              ? (netPnlNum / tradeValueUsd) * 100
              : 0;
            const isAiFill = !isSpotFill && isAiAgentCloid(f.cloid ?? f.c);

            return (
              <View key={rowKey} style={styles.positionRow}>
                <View style={styles.positionTop}>
                  <View style={styles.positionTitleRow}>
                    {isAiFill ? (
                      <TouchableOpacity
                        style={styles.aiAgentNav}
                        onPress={() => pushRouteOnce(router, '/ai-agents')}
                        activeOpacity={0.7}
                        hitSlop={6}
                      >
                        <MaterialCommunityIcons name="robot-outline" size={13} color={colors.accent.gold} />
                        <Ionicons name="chevron-forward" size={10} color={colors.text.tertiary} />
                      </TouchableOpacity>
                    ) : null}
                    {showAssetNavForCoin(coin, isSpotFill) ? (
                      <TouchableOpacity style={styles.symbolBadgeNav} onPress={() => navigateToAsset(coin, { isSpot: isSpotFill })} activeOpacity={0.6}>
                        <Text style={styles.symbolBadgeText}>{formatDisplaySymbol(coin)}</Text>
                        <Ionicons name="chevron-forward" size={10} color={colors.text.tertiary} />
                      </TouchableOpacity>
                    ) : (
                      <View style={styles.symbolBadge}>
                        <Text style={styles.symbolBadgeText}>{formatDisplaySymbol(coin)}</Text>
                      </View>
                    )}
                    <View style={[styles.sidePill, isBuy ? styles.sidePillLong : styles.sidePillShort]}>
                      <Text style={[styles.sidePillText, isBuy ? styles.sidePillTextLong : styles.sidePillTextShort]}>{sideLabel}</Text>
                    </View>
                  </View>
                </View>

                <View style={styles.metricsGrid}>
                  <View style={styles.metricColumn}>
                    <View style={styles.metricItem}>
                      <Text style={styles.metricLabel}>{t('trading.price')}</Text>
                      <Text style={styles.metricValue}>{formatPriceNum(pxNum)}</Text>
                    </View>
                    <View style={styles.metricItem}>
                      <Text style={styles.metricLabel}>{t('tradeHistory.fee')}</Text>
                      <Text style={styles.metricValue}>{Number.isFinite(feeNum) ? formatSignedUsdDisplay(feeNum) : '--'}</Text>
                    </View>
                  </View>
                  <View style={styles.metricColumn}>
                    <View style={styles.metricItem}>
                      <Text style={styles.metricLabel}>{t('tradeHistory.tradeValue')}</Text>
                      <Text style={styles.metricValue}>{Number.isFinite(tradeValueUsd) ? formatPriceNum(tradeValueUsd) : '--'}</Text>
                    </View>
                    <View style={styles.metricItem}>
                      <Text style={styles.metricLabel}>{t('tradeHistory.time')}</Text>
                      <Text style={styles.metricValue}>{timeStr}</Text>
                    </View>
                  </View>
                </View>
              </View>
            );
          })}
          {hasMoreFills ? (
            <TouchableOpacity style={styles.viewAllHistoryButton} onPress={() => pushRouteOnce(router, '/trade-history')}>
              <Text style={styles.viewAllHistoryText}>{t('tradeHistory.viewAllHistory', { count: fills.length - HISTORY_DISPLAY_LIMIT })}</Text>
              <Ionicons name="arrow-forward" size={12} color={colors.accent.gold} />
            </TouchableOpacity>
          ) : null}
        </>
      )}
      <Modal visible={showFilterModal} transparent animationType="fade" onRequestClose={() => setShowFilterModal(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <Text style={styles.modalTitle}>{t('portfolio.filterBySymbol')}</Text>
              <TouchableOpacity onPress={() => setShowFilterModal(false)}>
                <Ionicons name="close" size={22} color={colors.text.primary} />
              </TouchableOpacity>
            </View>
            <View style={{ maxHeight: 300 }}>
              <TouchableOpacity
                style={[styles.filterOption, !filterSymbol && styles.filterOptionActive]}
                onPress={() => {
                  setFilterSymbol(null);
                  setShowFilterModal(false);
                }}
              >
                <Ionicons
                  name={!filterSymbol ? 'radio-button-on' : 'radio-button-off'}
                  size={18}
                  color={!filterSymbol ? colors.accent.gold : colors.text.tertiary}
                />
                <Text style={[styles.filterOptionText, !filterSymbol && styles.filterOptionTextActive]}>
                  {t('portfolio.allSymbols')}
                </Text>
              </TouchableOpacity>
              {availableSymbols.map((symbol) => (
                <TouchableOpacity
                  key={symbol}
                  style={[styles.filterOption, filterSymbol === symbol && styles.filterOptionActive]}
                  onPress={() => {
                    setFilterSymbol(symbol);
                    setShowFilterModal(false);
                  }}
                >
                  <Ionicons
                    name={filterSymbol === symbol ? 'radio-button-on' : 'radio-button-off'}
                    size={18}
                    color={filterSymbol === symbol ? colors.accent.gold : colors.text.tertiary}
                  />
                  <Text style={[styles.filterOptionText, filterSymbol === symbol && styles.filterOptionTextActive]}>
                    {formatDisplaySymbol(symbol)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </View>
      </Modal>
      {ENABLE_ORDER_EDIT ? (
        <Modal visible={!!editOrderModal} transparent animationType="fade" onRequestClose={() => setEditOrderModal(null)}>
          <View style={styles.modalBackdrop}>
            <KeyboardAwareScrollView
              contentContainerStyle={styles.modalScrollContent}
              keyboardShouldPersistTaps="handled"
              bottomOffset={24}
            >
              <View style={styles.modalCard}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <Text style={styles.modalTitle}>{t('portfolio.editOrder')}</Text>
                  <TouchableOpacity onPress={() => setEditOrderModal(null)} disabled={editOrderLoading}>
                    <Ionicons name="close" size={22} color={colors.text.primary} />
                  </TouchableOpacity>
                </View>
                {(() => {
                  if (!editOrderModal) return null;
                  // Pull leverage from the matching open position so we can
                  // surface it next to the symbol (e.g. "10x MSTR · Limit").
                  // Safe fallback: if no position exists for this symbol we
                  // just render the symbol/type line without the badge.
                  const headerPos = findPositionForSymbol(filteredPositions, editOrderModal.symbol);
                  const headerLevObj = headerPos?.leverage;
                  const headerLevNum =
                    typeof headerLevObj === 'object' && headerLevObj?.value != null
                      ? safeNum(headerLevObj.value)
                      : safeNum(headerLevObj);
                  const showLevBadge = Number.isFinite(headerLevNum) && headerLevNum > 0;
                  const typeText = editOrderModal.isTrigger
                    ? (editOrderModal.tpsl === 'tp'
                        ? 'Take Profit'
                        : editOrderModal.tpsl === 'sl'
                          ? 'Stop Loss'
                          : 'Trigger')
                    : t('trading.limit');
                  return (
                    <View style={styles.editHeaderRow}>
                      {showLevBadge ? (
                        <Text style={styles.editLevText}>{`${Math.round(headerLevNum)}x`}</Text>
                      ) : null}
                      <Text style={styles.editHeaderText} numberOfLines={1}>
                        {`${formatDisplaySymbol(editOrderModal.symbol)} · ${typeText}`}
                      </Text>
                    </View>
                  );
                })()}
                <Text style={styles.inputLabelStandalone}>{editOrderModal?.isTrigger ? (t('trading.triggerPrice') ?? 'Trigger Price') : t('trading.limitPrice')}</Text>
                <TextInput
                  value={editLimitPxText}
                  onChangeText={(text) => {
                    setEditLimitPxText(text);
                    if (editOrderError) setEditOrderError(null);
                  }}
                  keyboardType="decimal-pad"
                  placeholder="0"
                  placeholderTextColor={colors.text.tertiary}
                  style={styles.input}
                  editable={!editOrderLoading}
                />
                {editOrderError ? (
                  <Text style={styles.modalInlineError}>{editOrderError}</Text>
                ) : null}
                <Text style={[styles.inputLabelStandalone, { marginTop: 12 }]}>{t('trading.size')}</Text>
                {(() => {
                  if (!editOrderModal) return (
                    <TextInput
                      value={editSizeText}
                      onChangeText={setEditSizeText}
                      keyboardType="decimal-pad"
                      placeholder="0"
                      placeholderTextColor={colors.text.tertiary}
                      style={styles.input}
                      editable={!editOrderLoading}
                    />
                  );
                  const editedPx = parseFloat(editLimitPxText.replace(/[^0-9.]/g, ''));
                  const editedSz = parseFloat(editSizeText.replace(/[^0-9.]/g, ''));
                  const sizeUsd = Number.isFinite(editedSz) && Number.isFinite(editedPx) && editedPx > 0 ? editedSz * editedPx : NaN;
                  const pos = findPositionForSymbol(filteredPositions, editOrderModal.symbol);
                  const entryPx = pos ? safeNum(pos.entryPx ?? pos.avgEntryPx) : NaN;
                  const sziNum = pos ? parseFloat(pos.szi ?? '0') : 0;
                  const sziAbs = Math.abs(sziNum);
                  const levObj = pos?.leverage;
                  const levNum = typeof levObj === 'object' && levObj?.value != null ? safeNum(levObj.value) : safeNum(levObj);
                  const effectiveLev = Number.isFinite(levNum) && levNum > 0 ? levNum : NaN;
                  const marginRequired = Number.isFinite(sizeUsd) && Number.isFinite(effectiveLev) ? sizeUsd / effectiveLev : NaN;

                  const isSellSide = editOrderModal.side === 'sell';
                  const isLongPos = sziNum > 0;
                  const isShortPos = sziNum < 0;
                  const hasPos = sziAbs > 0;
                  const forcedReduce = !!(editOrderModal.isTrigger || editOrderModal.reduceOnly);
                  const isReducingPos =
                    hasPos && (forcedReduce || (isLongPos && isSellSide) || (isShortPos && !isSellSide));
                  const isAddingToPos =
                    hasPos && !forcedReduce && ((isLongPos && !isSellSide) || (isShortPos && isSellSide));

                  // Exit PnL — cap the exit size at the current position size
                  // (any excess would flip the position, not extend exit PnL).
                  const exitSizeForCalc = isReducingPos
                    ? (Number.isFinite(editedSz) && editedSz > 0 ? Math.min(editedSz, sziAbs) : sziAbs)
                    : NaN;
                  const exitPnl =
                    isReducingPos &&
                    Number.isFinite(entryPx) && entryPx > 0 &&
                    Number.isFinite(editedPx) && editedPx > 0 &&
                    Number.isFinite(exitSizeForCalc) && exitSizeForCalc > 0
                      ? (editedPx - entryPx) * exitSizeForCalc * (isLongPos ? 1 : -1)
                      : NaN;
                  const positionMarginUsed = safeNum(pos?.marginUsed ?? pos?.marginUsedUsd ?? pos?.positionMargin);
                  const marginForExit = (() => {
                    if (
                      Number.isFinite(positionMarginUsed) &&
                      positionMarginUsed > 0 &&
                      Number.isFinite(exitSizeForCalc) &&
                      Number.isFinite(sziAbs) &&
                      sziAbs > 0
                    ) {
                      return positionMarginUsed * Math.min(1, exitSizeForCalc / sziAbs);
                    }
                    if (Number.isFinite(effectiveLev) && effectiveLev > 0 && Number.isFinite(entryPx) && Number.isFinite(exitSizeForCalc)) {
                      return (entryPx * exitSizeForCalc) / effectiveLev;
                    }
                    return NaN;
                  })();
                  const exitRoePct =
                    Number.isFinite(exitPnl) && Number.isFinite(marginForExit) && marginForExit > 0
                      ? (exitPnl / marginForExit) * 100
                      : NaN;
                  const isGain = Number.isFinite(exitPnl) && exitPnl >= 0;

                  // Projected new average entry for same-side adds.
                  // weighted-average: (entryPx·|szi| + editedPx·editedSz) / (|szi| + editedSz)
                  const addNewAvgEntry =
                    isAddingToPos &&
                    Number.isFinite(entryPx) && entryPx > 0 &&
                    Number.isFinite(editedSz) && editedSz > 0 &&
                    Number.isFinite(editedPx) && editedPx > 0
                      ? (entryPx * sziAbs + editedPx * editedSz) / (sziAbs + editedSz)
                      : NaN;

                  return (
                    <>
                      <TextInput
                        value={editSizeText}
                        onChangeText={setEditSizeText}
                        keyboardType="decimal-pad"
                        placeholder="0"
                        placeholderTextColor={colors.text.tertiary}
                        style={styles.input}
                        editable={!editOrderLoading}
                      />
                      {Number.isFinite(sizeUsd) ? (
                        <Text style={{ fontSize: 12, color: colors.text.tertiary, marginTop: 6, paddingHorizontal: 4 }}>
                          {`≈ ${formatPriceNum(sizeUsd)}`}
                          {Number.isFinite(marginRequired) ? `  ·  ~${formatPriceNum(marginRequired)} margin` : ''}
                        </Text>
                      ) : null}
                      {(() => {
                        // Mini-simulator card. We only render it when we have
                        // something meaningful to show (reduce PnL or new avg
                        // entry on a same-side add). Live market price comes
                        // from the same allMids fallback the rest of the table
                        // uses, so this preview stays consistent with the row.
                        const showReduce = isReducingPos && Number.isFinite(exitPnl);
                        const showAdd = isAddingToPos && Number.isFinite(addNewAvgEntry);
                        if (!showReduce && !showAdd) return null;

                        const liveRaw = getLivePrice(editOrderModal.symbol);
                        const liveNum = typeof liveRaw === 'string' || typeof liveRaw === 'number'
                          ? parseFloat(String(liveRaw))
                          : NaN;
                        const hasLive = Number.isFinite(liveNum) && liveNum > 0;

                        return (
                          <View style={styles.previewCard}>
                            <View style={styles.previewHeader}>
                              <Text style={styles.previewTitle}>{t('portfolio.previewTitle')}</Text>
                              {hasLive ? (
                                <View style={styles.previewLive}>
                                  <LivePulseDot />
                                  <Text style={styles.previewLiveLabel}>{t('trading.price')}</Text>
                                  <Text style={styles.previewLiveValue}>{formatPriceNum(liveNum)}</Text>
                                </View>
                              ) : null}
                            </View>

                            {showReduce ? (
                              <>
                                <View style={styles.previewRow}>
                                  <Text style={styles.previewLabel}>{t('portfolio.exitPriceLabel')}</Text>
                                  <Text style={styles.previewValue}>{formatPriceNum(editedPx)}</Text>
                                </View>
                                <View style={styles.previewRow}>
                                  <Text style={styles.previewLabel}>{t('portfolio.entryLabel')}</Text>
                                  <Text style={styles.previewValue}>{formatPriceNum(entryPx)}</Text>
                                </View>
                                <View
                                  style={[
                                    styles.previewResult,
                                    isGain ? styles.previewResultGain : styles.previewResultLoss,
                                  ]}
                                >
                                  <Text
                                    style={[
                                      styles.previewResultLabel,
                                      { color: isGain ? colors.status.success : colors.status.error },
                                    ]}
                                  >
                                    {isGain ? t('portfolio.estGainLabel') : t('portfolio.estLossLabel')}
                                  </Text>
                                  <Text
                                    style={[
                                      styles.previewResultValue,
                                      { color: isGain ? colors.status.success : colors.status.error },
                                    ]}
                                  >
                                    {isGain
                                      ? `+${formatPriceNum(exitPnl)}`
                                      : `-${formatPriceNum(Math.abs(exitPnl))}`}
                                    {Number.isFinite(exitRoePct) ? ` (${exitRoePct.toFixed(2)}% ROE)` : ''}
                                  </Text>
                                </View>
                              </>
                            ) : (
                              <>
                                <View style={styles.previewRow}>
                                  <Text style={styles.previewLabel}>{t('portfolio.fillPriceLabel')}</Text>
                                  <Text style={styles.previewValue}>{formatPriceNum(editedPx)}</Text>
                                </View>
                                <View style={styles.previewRow}>
                                  <Text style={styles.previewLabel}>{t('portfolio.currentEntryLabel')}</Text>
                                  <Text style={styles.previewValue}>{formatPriceNum(entryPx)}</Text>
                                </View>
                                <View style={[styles.previewResult, styles.previewResultInfo]}>
                                  <Text style={styles.previewResultLabelMuted}>
                                    {isLongPos
                                      ? t('portfolio.addsToLongLabel')
                                      : t('portfolio.addsToShortLabel')}
                                  </Text>
                                  <Text style={styles.previewResultValue}>
                                    {formatPriceNum(addNewAvgEntry)}
                                  </Text>
                                </View>
                              </>
                            )}
                          </View>
                        );
                      })()}
                    </>
                  );
                })()}
                <View style={styles.modalButtons}>
                  <TouchableOpacity
                    style={styles.modalSecondary}
                    onPress={() => setEditOrderModal(null)}
                    disabled={editOrderLoading}
                  >
                    <Text style={styles.modalSecondaryText}>{t('common.cancel')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.modalPrimary}
                    onPress={async () => {
                      if (!editOrderModal || !onModifyOrder) return;
                      const px = parseFloat(editLimitPxText.replace(/[^0-9.]/g, ''));
                      if (!Number.isFinite(px) || px <= 0) {
                        setEditOrderError(t('errors.enterValidLimitPrice'));
                        return;
                      }
                      const sz = parseFloat(editSizeText.replace(/[^0-9.]/g, ''));
                      if (!Number.isFinite(sz) || sz <= 0) {
                        setEditOrderError(t('errors.enterValidSize') ?? 'Enter a valid size');
                        return;
                      }
                      const referencePx = editOrderModal.referencePx;
                      const wouldTakeLiquidity =
                        !editOrderModal.isTrigger &&
                        Number.isFinite(referencePx ?? NaN) &&
                        (editOrderModal.side === 'buy'
                          ? px >= (referencePx as number)
                          : px <= (referencePx as number));
                      if (wouldTakeLiquidity) {
                        setEditOrderError(t('errors.hyperliquid.badAloPxRejectedMessage'));
                        return;
                      }
                      try {
                        setEditOrderLoading(true);
                        await onModifyOrder({ ...editOrderModal, sizeUnits: String(sz) }, px);
                        setEditOrderModal(null);
                      } catch (e: any) {
                        setEditOrderError(e?.message ? humanizeHyperliquidError(String(e.message)).message : t('errors.failedToModifyOrder'));
                      } finally {
                        setEditOrderLoading(false);
                      }
                    }}
                    disabled={editOrderLoading}
                  >
                    {editOrderLoading ? (
                      <ActivityIndicator color={colors.background.primary} />
                    ) : (
                      <Text style={styles.modalPrimaryText}>{t('common.save')}</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            </KeyboardAwareScrollView>
          </View>
        </Modal>
      ) : null}
      <Modal visible={!!confirmAction} transparent animationType="fade" onRequestClose={() => setConfirmAction(null)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{confirmTitle}</Text>
            <Text style={styles.modalText}>{confirmBody}</Text>
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.modalSecondary} onPress={() => setConfirmAction(null)} disabled={isConfirmLoading}>
                <Text style={styles.modalSecondaryText}>{t('common.notNow')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.modalPrimary}
                onPress={() => {
                  if (confirmAction === 'close_all') {
                    bulkCloseSnapshotRef.current = new Set(
                      filteredPositions.map((p: any) => positionRenderKey(p)),
                    );
                    setBulkCloseActive(true);
                    if (bulkCloseSafetyRef.current) clearTimeout(bulkCloseSafetyRef.current);
                    bulkCloseSafetyRef.current = setTimeout(clearBulkCloseHold, BULK_SAFETY_MS);
                    onCloseAllPositions?.();
                  } else if (confirmAction === 'cancel_all') {
                    bulkCancelSnapshotRef.current = new Set(
                      filteredOpenOrders
                        .map((o: any) => Number(o?.oid ?? o?.order?.oid ?? o?.o?.oid))
                        .filter((oid: number) => Number.isFinite(oid)),
                    );
                    setBulkCancelActive(true);
                    if (bulkCancelSafetyRef.current) clearTimeout(bulkCancelSafetyRef.current);
                    bulkCancelSafetyRef.current = setTimeout(clearBulkCancelHold, BULK_SAFETY_MS);
                    onCancelAllOrders?.();
                  }
                  setConfirmAction(null);
                }}
                disabled={isConfirmLoading}
              >
                {isConfirmLoading ? (
                  <ActivityIndicator color={colors.background.primary} />
                ) : (
                  <Text style={styles.modalPrimaryText}>{confirmCta}</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
      <Modal
        visible={!!confirmClosePosition}
        transparent
        animationType="fade"
        onRequestClose={() => setConfirmClosePosition(null)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>
              {confirmClosePosition ? t('portfolio.closePositionForSymbol', { symbol: formatDisplaySymbol(confirmClosePosition.coin) }) : t('portfolio.closePosition')}
            </Text>
            <Text style={styles.modalText}>{t('portfolio.closePositionDescription')}</Text>
            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={styles.modalSecondary}
                onPress={() => setConfirmClosePosition(null)}
                disabled={isSubmitting}
              >
                <Text style={styles.modalSecondaryText}>{t('common.notNow')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.modalPrimary}
                onPress={() => {
                  // Modal dismiss animation (~200ms fade) covers the list with
                  // a dark backdrop. On pages where HL's WS round-trip is fast
                  // (portfolio.tsx especially), the position can be removed from
                  // `positions` AND finish its FadeOut while the backdrop is
                  // still obscuring the list — user sees the row "just vanish".
                  //
                  // Set the optimistic key synchronously so `useHeldKey`'s timer
                  // starts now (no wasted time), then defer the actual
                  // `onClosePosition` dispatch until the backdrop is out of the
                  // way. Net effect: spinner is already on-screen when the WS
                  // drops the row, and the row's FadeOut plays in the clear.
                  if (confirmClosePosition) {
                    const payload = confirmClosePosition;
                    setOptimisticClosingKey(`${payload.coin}:${payload.szi}`);
                    setConfirmClosePosition(null);
                    setTimeout(() => {
                      onClosePosition(payload.coin, payload.szi);
                    }, MODAL_DISMISS_MS);
                  } else {
                    setConfirmClosePosition(null);
                  }
                }}
                disabled={isSubmitting}
              >
                <Text style={styles.modalPrimaryText}>{t('portfolio.closePosition')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {reasoningModal ? (
        <AiReasoningModal
          visible={!!reasoningModal}
          agentId={reasoningModal.agentId}
          agentName={reasoningModal.agentName}
          symbol={reasoningModal.symbol}
          direction={reasoningModal.direction}
          since={reasoningModal.openedAt}
          onClose={() => setReasoningModal(null)}
        />
      ) : null}
      {sharedAiModal}
    </LinearGradient>
  );
});

const styles = StyleSheet.create({
  // Clip row exit/layout animations so a fading row can't paint below the card edge.
  positionsCard: {
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.border.primary,
    marginHorizontal: 16,
    marginBottom: 16,
    overflow: 'hidden',
  },
  positionsCardNoMargin: { marginHorizontal: 0 },
  positionsHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8 },
  positionsEmpty: { color: colors.text.tertiary, fontSize: 12, paddingVertical: 6, textAlign: 'center' },
  headerActionsRow: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 6, marginTop: -2, marginBottom: 6 },
  readOnlyHint: {
    color: colors.text.tertiary,
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 6,
    marginTop: -2,
  },
  // When demo badge is present, swap to space-between so the badge lives
  // on the left and the existing action buttons stay floated right.
  headerActionsRowSplit: { justifyContent: 'space-between' },
  headerActionsRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  filterButton: {
    padding: 5,
    borderRadius: 7,
    backgroundColor: colors.background.tertiary,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  headerActionButton: {
    paddingVertical: 5,
    paddingHorizontal: 8,
    borderRadius: 9,
    backgroundColor: colors.background.tertiary,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  headerActionText: { color: colors.text.primary, fontSize: 10, fontWeight: '800' },
  filterOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 8,
    marginBottom: 4,
  },
  filterOptionActive: {
    backgroundColor: `${colors.accent.gold}15`,
  },
  filterOptionText: {
    color: colors.text.secondary,
    fontSize: 14,
    fontWeight: '700',
  },
  filterOptionTextActive: {
    color: colors.accent.gold,
  },

  portfolioTabs: { flexDirection: 'row', gap: 6, flex: 1 },
  portfolioTab: { flex: 1, paddingVertical: 8, borderRadius: 9, alignItems: 'center', backgroundColor: colors.background.tertiary, borderWidth: 1, borderColor: colors.border.primary },
  portfolioTabActive: { backgroundColor: `${colors.accent.gold}25`, borderColor: colors.accent.gold },
  portfolioTabText: { color: colors.text.secondary, fontSize: 11, fontWeight: '800' },
  portfolioTabTextActive: { color: colors.accent.gold },

  positionRow: { paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.border.primary },
  positionRowInner: { width: '100%' },
  positionRowProcessing: { opacity: 0.72 },
  positionContent: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 2 },
  positionLeft: { flex: 1 },
  positionTop: { flexDirection: 'row', alignItems: 'center' },
  positionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, flexWrap: 'wrap' },
  positionCoin: { color: colors.text.primary, fontSize: 12, fontWeight: '800' },
  positionActions: { flexDirection: 'column', alignItems: 'flex-end', gap: 6, width: ACTION_COLUMN_WIDTH },
  positionActionButton: {
    paddingVertical: 5,
    paddingHorizontal: 8,
    borderRadius: 8,
    backgroundColor: colors.background.tertiary,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  positionActionButtonDisabled: { opacity: 0.6 },
  positionActionText: { color: colors.accent.gold, fontSize: 10, fontWeight: '800' },
  aiAgentNav: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 1,
    paddingLeft: 4,
    paddingRight: 2,
    paddingVertical: 2,
    borderRadius: 5,
    backgroundColor: 'rgba(92,225,230,0.12)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.accent.goldDark,
  },
  positionAction: { color: colors.accent.gold, fontSize: 10, fontWeight: '800' },
  symbolBadge: {
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 5,
    backgroundColor: colors.background.tertiary,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  symbolBadgeNav: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingLeft: 5,
    paddingRight: 3,
    paddingVertical: 2,
    borderRadius: 5,
    backgroundColor: colors.background.tertiary,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  symbolBadgeText: { color: colors.text.primary, fontSize: 10, fontWeight: '800' },

  sidePill: { paddingHorizontal: 6, paddingVertical: 3, borderRadius: 999, borderWidth: 1 },
  sidePillLong: { backgroundColor: `${colors.status.success}15`, borderColor: `${colors.status.success}55` },
  sidePillShort: { backgroundColor: `${colors.status.error}15`, borderColor: `${colors.status.error}55` },
  sidePillText: { fontSize: 10, fontWeight: '900' },
  sidePillTextLong: { color: colors.status.success },
  sidePillTextShort: { color: colors.status.error },

  metricsGrid: { flexDirection: 'row', gap: 12, marginTop: 14 },
  metricColumn: { flex: 1, gap: 14 },
  metricItem: { minHeight: 28 },
  metricItemPlaceholder: { minHeight: 28 },
  metricLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  metricLabel: { color: colors.text.tertiary, fontSize: 10, fontWeight: '800', lineHeight: 12 },
  metricValue: { color: colors.text.primary, fontSize: 11, fontWeight: '800', marginTop: 6, lineHeight: 13 },
  metricPct: { fontSize: 9, fontWeight: '700', marginTop: 2, lineHeight: 11 },
  metricSpacer: { height: 6 },
  metricValueRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginTop: 2 },
  metricInlineButton: {
    paddingVertical: 3,
    paddingHorizontal: 5,
    borderRadius: 7,
    backgroundColor: colors.background.tertiary,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  metricButton: { alignSelf: 'flex-start', paddingVertical: 6, paddingHorizontal: 8, borderRadius: 8, backgroundColor: colors.background.tertiary, borderWidth: 1, borderColor: colors.border.primary },
  metricButtonText: { color: colors.accent.gold, fontSize: 10, fontWeight: '900' },

  pnlShareText: { color: colors.accent.gold, fontSize: 10, fontWeight: '800' },
  pnlInlineRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  pnlInlineButton: {
    paddingVertical: 3,
    paddingHorizontal: 5,
    borderRadius: 7,
    backgroundColor: colors.background.tertiary,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  viewAllHistoryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    marginTop: 8,
    marginBottom: -12,
    paddingTop: 16,
    paddingBottom: 16,
    borderTopWidth: 1,
    borderTopColor: colors.border.primary,
  },
  viewAllHistoryText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.accent.gold,
    letterSpacing: 0.1,
  },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', padding: 20 },
  modalScrollContent: { flexGrow: 1, justifyContent: 'center' },
  modalCard: { backgroundColor: colors.background.primary, borderRadius: 16, borderWidth: 1, borderColor: colors.border.primary, padding: 16 },
  modalTitle: { color: colors.text.primary, fontSize: 16, fontWeight: '900', marginBottom: 8 },
  modalText: { color: colors.text.secondary, fontSize: 13, lineHeight: 18, marginBottom: 12 },
  modalInlineError: { color: colors.status.error, fontSize: 11, fontWeight: '600', marginTop: 6 },
  modalButtons: { flexDirection: 'row', gap: 10, marginTop: 14 },
  modalSecondary: { flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center', backgroundColor: colors.background.tertiary, borderWidth: 1, borderColor: colors.border.primary },
  modalSecondaryText: { color: colors.text.primary, fontSize: 13, fontWeight: '800' },
  modalPrimary: { flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center', backgroundColor: colors.accent.gold },
  modalPrimaryText: { color: colors.background.primary, fontSize: 13, fontWeight: '900' },
  inputLabelStandalone: { color: colors.text.tertiary, fontSize: 12, fontWeight: '700', marginBottom: 8 },
  input: {
    borderWidth: 1,
    borderColor: colors.border.primary,
    backgroundColor: colors.background.card,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    color: colors.text.primary,
    fontSize: 14,
  },
  editHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  editLevText: {
    color: colors.accent.gold,
    fontSize: 13,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
    lineHeight: 14,
    letterSpacing: 0.3,
    includeFontPadding: false,
    textAlignVertical: 'center',
  },
  editHeaderText: {
    color: colors.text.primary,
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 14,
    includeFontPadding: false,
    textAlignVertical: 'center',
    flexShrink: 1,
  },
  previewCard: {
    marginTop: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border.primary,
    backgroundColor: 'rgba(255,255,255,0.02)',
    padding: 12,
  },
  previewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  previewTitle: {
    color: colors.text.secondary,
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  previewLive: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  previewLiveLabel: {
    color: colors.text.tertiary,
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  previewLiveValue: {
    color: colors.text.primary,
    fontSize: 12,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
    marginLeft: 2,
  },
  previewRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
  },
  previewLabel: {
    color: colors.text.tertiary,
    fontSize: 12,
  },
  previewValue: {
    color: colors.text.primary,
    fontSize: 13,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  previewResult: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  previewResultGain: {
    backgroundColor: 'rgba(0, 200, 120, 0.08)',
    borderColor: 'rgba(0, 200, 120, 0.35)',
  },
  previewResultLoss: {
    backgroundColor: 'rgba(230, 70, 70, 0.08)',
    borderColor: 'rgba(230, 70, 70, 0.35)',
  },
  previewResultInfo: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderColor: colors.border.primary,
  },
  previewResultLabel: {
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  previewResultLabelMuted: {
    fontSize: 10,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    color: colors.text.secondary,
  },
  previewResultValue: {
    fontSize: 12,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
    color: colors.text.primary,
  },
  previewFootnote: {
    marginTop: 6,
    fontSize: 11,
    color: colors.text.tertiary,
    textAlign: 'right',
  },
});
