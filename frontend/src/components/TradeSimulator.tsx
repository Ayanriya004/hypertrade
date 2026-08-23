import React, { useEffect, useMemo, useRef, useState, memo } from 'react';
import { Animated, Easing, StyleSheet, Text, View, TouchableOpacity, Modal } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useTranslation } from 'react-i18next';
import { colors } from '../theme/colors';
import { useBuilderConfig } from '../providers/BuilderConfigProvider';
import { buildMaintenanceSchedule, estimateLiqPriceCross, estimateLiqPriceIsolated, maintenanceMarginRequired, type MarginTier } from '../lib/hlMargin';
import { useIsDemo } from './DemoMode';
import { CurrencyHint } from './CurrencyHint';

function formatPriceSmart(n: number): string {
  if (!Number.isFinite(n)) return '--';
  const abs = Math.abs(n);
  if (abs >= 100) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (abs >= 10) return n.toFixed(3);
  if (abs >= 1) return n.toFixed(3);
  if (abs >= 0.1) return n.toFixed(4);
  return n.toFixed(6);
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

type Props = {
  entryPx: number;
  side: 'long' | 'short';
  sizeUsd: number;     // Notional Size (e.g. $2000)
  sizeUnits: number;   // e.g. 1.0 OZ
  leverage: number;
  takerFeeRate?: number; // default ~0.00035 (3.5bps)
  makerFeeRate?: number;
  orderType?:
    | 'market'
    | 'limit'
    | 'stop_market'
    | 'stop_limit'
    | 'take_market'
    | 'take_limit';
  marginTiers?: MarginTier[] | null;
  marginMode?: 'isolated' | 'cross';
  // For cross liquidation estimate we need total account equity (account value).
  accountEquityUsd?: number;
  /**
   * `crossMaintenanceMarginUsed` for THIS asset's dex pool. Pairs with
   * `accountEquityUsd` to give HL's authoritative shared
   * `margin_available` scalar:
   *
   *   margin_available = accountEquityUsd − crossMaintenanceMarginUsedUsd
   *
   * Critical for projecting liq when the user has OTHER cross positions
   * in the same pool (different assets) but no existing position on
   * THIS asset — without it we ignore those positions' maintenance
   * margin and the projected liq drifts unsafe.
   */
  crossMaintenanceMarginUsedUsd?: number;
  /**
   * HL account abstraction mode (`userAbstraction` endpoint). Determines
   * how cross-margin equity is pooled. The default for app.hyperliquid.xyz
   * is `unifiedAccount`, where ALL USDC-backed cross dexes share one pool
   * and per-dex `crossMarginSummary.accountValue` is meaningless.
   */
  accountAbstractionMode?:
    | 'unifiedAccount'
    | 'portfolioMargin'
    | 'disabled'
    | 'default'
    | 'dexAbstraction'
    | null;
  /**
   * UNIFIED-MODE inputs. Used only when `accountAbstractionMode` is
   * `unifiedAccount` or `portfolioMargin`. See QuickTradeCard for the
   * full rationale. Without these, projecting a NEW cross position on a
   * HIP-3 dex (e.g. TSLA on `xyz`) without an existing same-dex cross
   * falls through to isolated math and shows wildly wrong liqs.
   */
  unifiedSpotUsdcBalanceUsd?: number;
  unifiedTotalIsolatedMarginUsedUsd?: number;
  unifiedTotalCrossMaintenanceMarginUsedUsd?: number;
  debugCrossLiqInputs?: Record<string, any> | null;
  existingPosition?: {
    entryPx: number;
    side: 'long' | 'short';
    sizeUnits: number;
    leverage?: number;
    marginUsedUsd?: number;
    markPx?: number;
    // 'cross' / 'isolated'. Used to decide whether the existing position
    // can anchor the cross-margin liq projection (only cross positions
    // share the cross pool's `margin_available`).
    marginType?: 'cross' | 'isolated';
    // Exchange-reported liquidation price for the existing position. When
    // present, we display this value directly (matching PortfolioTabs /
    // QuickTradeCard) instead of our projected post-fill liq, so all three
    // surfaces agree on "the" liq price when the user already has exposure.
    // We also use it to back-solve HL's exact `margin_available` for
    // cross-liq projections (anchor mode in `estimateLiqPriceCross`).
    liquidationPx?: number | null;
  } | null;
  // Live market price (mid) from allMids WS — shown at the top of the card so
  // the user can see where the market is versus their order. Snapshot prices
  // lag; this feed is still the shared fallback when no faster local quote is available.
  livePrice?: number | null;
  // Visual feedback states
  isCalculating?: boolean; // True while slider/input changes are being processed
  isLoading?: boolean;     // True during initial data load
};

// Tiny pulsing green dot to signal a "live" value. Kept local so any row can
// reuse it without pulling in extra deps.
const LiveDot = memo(function LiveDot() {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 900,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 900,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] });
  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1.15] });
  return (
    <Animated.View
      style={{
        width: 7,
        height: 7,
        borderRadius: 4,
        backgroundColor: colors.status.success,
        opacity,
        transform: [{ scale }],
      }}
    />
  );
});

function safe(n: number) {
  return Number.isFinite(n) ? n : 0;
}

export const TradeSimulator: React.FC<Props> = memo(function TradeSimulator({ 
  entryPx, 
  side, 
  sizeUsd, 
  sizeUnits, 
  leverage, 
  takerFeeRate,
  makerFeeRate, 
  orderType,
  marginTiers,
  marginMode,
  accountEquityUsd,
  crossMaintenanceMarginUsedUsd,
  accountAbstractionMode,
  unifiedSpotUsdcBalanceUsd,
  unifiedTotalIsolatedMarginUsedUsd,
  unifiedTotalCrossMaintenanceMarginUsedUsd,
  debugCrossLiqInputs,
  existingPosition,
  livePrice,
  isCalculating = false,
  isLoading = false,
}) {
  const { t } = useTranslation();
  // Demo mode flips the panel title to "Demo Trade Preview" so users
  // tracking projected P&L know the numbers are simulated against testnet
  // prices, not real market state.
  const isDemo = useIsDemo();
  const [showFeesModal, setShowFeesModal] = useState(false);
  const [showLiquidationModal, setShowLiquidationModal] = useState(false);
  const { builderFeeRate } = useBuilderConfig();

  // Track last live price + direction so we can tint the value up/down on the
  // very next tick, mimicking a ticker. Purely cosmetic; no re-renders forced.
  const hasLivePrice = Number.isFinite(livePrice ?? NaN) && (livePrice ?? 0) > 0;
  const prevLiveRef = useRef<number | null>(null);
  const [liveTint, setLiveTint] = useState<'up' | 'down' | null>(null);
  useEffect(() => {
    if (!hasLivePrice) return;
    const prev = prevLiveRef.current;
    const curr = livePrice as number;
    if (prev != null && Number.isFinite(prev) && prev !== curr) {
      setLiveTint(curr > prev ? 'up' : 'down');
      const id = setTimeout(() => setLiveTint(null), 600);
      prevLiveRef.current = curr;
      return () => clearTimeout(id);
    }
    prevLiveRef.current = curr;
  }, [hasLivePrice, livePrice]);
  
  const { estLiqPx, takerFeePct, makerFeePct, marginUsedUsd, orderValueUsd } = useMemo(() => {
    const px = safe(entryPx);
    const usd = safe(sizeUsd);
    const lev = Math.max(1, safe(leverage));

    // Fee rates are independent of size/price — always show them so the
    // drawer isn't blank before the user enters a size.
    const tRate = safe(takerFeeRate ?? 0) + builderFeeRate;
    const mRate = safe(makerFeeRate ?? 0) + builderFeeRate;
    const takerFeePct = tRate * 100;
    const makerFeePct = mRate * 100;

    if (px <= 0 || usd <= 0) {
      return {
        estLiqPx: null,
        takerFeePct,
        makerFeePct,
        marginUsedUsd: null,
        orderValueUsd: null,
      };
    }

    // Initial margin ("margin used" for this order if isolated):
    // IM = notional / leverage
    const marginUsedUsd = usd / lev;

    // Combine current position with this order for liquidation estimate.
    const existing = existingPosition;
    const orderSzi = (side === 'long' ? 1 : -1) * safe(sizeUnits);
    const existingSzi = existing
      ? (existing.side === 'long' ? 1 : -1) * safe(existing.sizeUnits)
      : 0;
    const combinedSzi = existingSzi + orderSzi;
    const combinedAbsSzi = Math.abs(combinedSzi);
    const combinedSide: 'long' | 'short' = combinedSzi >= 0 ? 'long' : 'short';

    // Note on opposing reductions: an earlier version of this code short-
    // circuited to null whenever the order side was opposite the final
    // combined side ("you're just reducing, no liq for that side"). That's
    // misleading — the *remaining* position still has a liq, and in cross
    // mode reducing actually makes it safer. Since TradeSimulator knows the
    // user's explicit side+size, we let the calc proceed in all cases and
    // rely on `combinedAbsSzi > 0` downstream to null-out the full-close
    // edge case only.

    let combinedEntryPx = px;
    if (existingSzi === 0) {
      combinedEntryPx = px;
    } else if (orderSzi === 0) {
      combinedEntryPx = safe(existing?.entryPx ?? 0);
    } else if (Math.sign(existingSzi) === Math.sign(orderSzi)) {
      // Same side -> weighted average
      combinedEntryPx =
        (Math.abs(existingSzi) * safe(existing?.entryPx ?? 0) + Math.abs(orderSzi) * px) /
        Math.max(1e-9, combinedAbsSzi);
    } else if (Math.abs(orderSzi) < Math.abs(existingSzi)) {
      // Reduction -> entry stays the same
      combinedEntryPx = safe(existing?.entryPx ?? 0);
    } else if (Math.abs(orderSzi) > Math.abs(existingSzi)) {
      // Flip -> new entry is the new order price
      combinedEntryPx = px;
    }

    // Estimate total initial margin to compute effective leverage for isolated liq.
    const existingNotional = Math.abs(existingSzi) * safe(existing?.entryPx ?? 0);
    const existingLev = Math.max(1, safe(existing?.leverage ?? lev));
    const existingMargin =
      Number.isFinite(existing?.marginUsedUsd ?? NaN) && (existing?.marginUsedUsd ?? 0) > 0
        ? safe(existing?.marginUsedUsd ?? 0)
        : existingNotional / existingLev;
    const orderNotional = Math.abs(orderSzi) * px;

    let totalInitialMargin = 0;
    if (existingSzi === 0) {
      totalInitialMargin = orderNotional / lev;
    } else if (Math.sign(existingSzi) === Math.sign(orderSzi)) {
      totalInitialMargin = existingMargin + orderNotional / lev;
    } else if (Math.abs(orderSzi) < Math.abs(existingSzi)) {
      const remainingRatio = (Math.abs(existingSzi) - Math.abs(orderSzi)) / Math.max(1e-9, Math.abs(existingSzi));
      totalInitialMargin = existingMargin * remainingRatio;
    } else if (Math.abs(orderSzi) === Math.abs(existingSzi)) {
      totalInitialMargin = 0;
    } else {
      const remainingUnits = Math.abs(orderSzi) - Math.abs(existingSzi);
      totalInitialMargin = (remainingUnits * px) / lev;
    }

    const combinedNotional = combinedAbsSzi * combinedEntryPx;
    const effectiveLev =
      totalInitialMargin > 0 ? Math.max(1, combinedNotional / totalInitialMargin) : lev;

    // 2) Liquidation estimate using HL margin tiers (maintenance_margin = notional * mmr - deduction).
    // Isolated uses initial margin = notional/leverage.
    // Cross follows HL's official formula (see hlMargin.ts). When the
    // user already has an open CROSS position on this asset we anchor
    // `margin_available` from HL's reported liquidation price — that
    // implicitly captures every other cross position in the same dex
    // pool (which raw `crossMarginSummary.accountValue` alone does not).
    // Without this anchor, projecting onto a multi-cross-position pool
    // overestimates margin_available and the projected liq drifts
    // safer than HL's; in compounding scenarios it can even point the
    // wrong direction.
    const tiers = marginTiers ?? undefined;
    const schedule = tiers?.length ? buildMaintenanceSchedule(tiers) : null;
    const existingCrossAnchor =
      existing &&
      existing.marginType === 'cross' &&
      Number.isFinite(existing.sizeUnits) &&
      existing.sizeUnits > 0
        ? {
            side: existing.side,
            sizeUnits: existing.sizeUnits,
            liquidationPx: Number.isFinite(existing.liquidationPx ?? NaN)
              ? (existing.liquidationPx as number)
              : 0,
            markPx: Number.isFinite(existing.markPx ?? NaN) ? existing.markPx : undefined,
          }
        : undefined;
    // Pool-mode inputs depending on HL account abstraction mode (see
    // HyperliquidTradingState comment in lib/hyperliquid.ts).
    //   unifiedAccount / portfolioMargin → ONE pool across USDC-backed
    //     dexes. Use spotUSDC − Σ isolatedMargin as the equity, and
    //     Σ crossMaintenanceMarginUsed (across all dexes) as the pool
    //     maint. Per-dex `crossMarginSummary.accountValue` is meaningless
    //     in these modes per HL docs.
    //   disabled / default / dexAbstraction → per-dex (legacy behaviour).
    const isUnifiedMode =
      accountAbstractionMode === 'unifiedAccount' ||
      accountAbstractionMode === 'portfolioMargin';
    const effectiveCrossEquity = isUnifiedMode
      ? Math.max(
          0,
          safe(unifiedSpotUsdcBalanceUsd ?? 0) - safe(unifiedTotalIsolatedMarginUsedUsd ?? 0),
        )
      : safe(accountEquityUsd ?? 0);
    const effectiveCrossMaintUsed = isUnifiedMode
      ? safe(unifiedTotalCrossMaintenanceMarginUsedUsd ?? 0)
      : safe(crossMaintenanceMarginUsedUsd ?? 0);
    const hasCrossEquity = effectiveCrossEquity > 0;
    const hasPoolMaint =
      ((isUnifiedMode &&
        Number.isFinite(unifiedTotalCrossMaintenanceMarginUsedUsd ?? NaN)) ||
        (!isUnifiedMode &&
          Number.isFinite(crossMaintenanceMarginUsedUsd ?? NaN) &&
          (crossMaintenanceMarginUsedUsd ?? -1) >= 0)) &&
      hasCrossEquity;
    const liq =
      schedule && combinedAbsSzi > 0
        ? marginMode === 'cross'
          ? (existingCrossAnchor || hasCrossEquity)
            ? estimateLiqPriceCross({
                markPx: px,
                side: combinedSide,
                sizeUnits: combinedAbsSzi,
                existing: existingCrossAnchor,
                accountValueUsd: effectiveCrossEquity,
                crossMaintenanceMarginUsedUsd: hasPoolMaint
                  ? effectiveCrossMaintUsed
                  : undefined,
                schedule,
              })
            : null
          : estimateLiqPriceIsolated({
              entryPx: combinedEntryPx,
              side: combinedSide,
              sizeUnits: combinedAbsSzi,
              leverage: effectiveLev,
              schedule,
            })
        : null;

    if (
      __DEV__ &&
      marginMode === 'cross' &&
      schedule &&
      combinedAbsSzi > 0 &&
      usd > 0
    ) {
      // Temporary diagnostics for matching HL's post-fill liquidation
      // preview. Keep this near the estimator so the logged values are
      // exactly the ones fed into `estimateLiqPriceCross`.
      const newMaintAtMark = maintenanceMarginRequired(combinedAbsSzi * px, schedule);
      const existingMaintAtMark =
        existingCrossAnchor && Number.isFinite(existingCrossAnchor.sizeUnits) && existingCrossAnchor.sizeUnits > 0
          ? maintenanceMarginRequired(existingCrossAnchor.sizeUnits * px, schedule)
          : 0;
      const postFillPoolMaint = hasPoolMaint
        ? effectiveCrossMaintUsed - existingMaintAtMark + newMaintAtMark
        : null;
      const marginAvailableUsed = postFillPoolMaint !== null
        ? effectiveCrossEquity - postFillPoolMaint
        : null;
      const debugPayload = {
        accountAbstractionMode,
        side,
        combinedSide,
        entryPx: px,
        orderUsd: usd,
        orderSizeUnits: safe(sizeUnits),
        combinedAbsSzi,
        existing: existing
          ? {
              side: existing.side,
              sizeUnits: existing.sizeUnits,
              entryPx: existing.entryPx,
              liquidationPx: existing.liquidationPx,
              marginType: existing.marginType,
              marginUsedUsd: existing.marginUsedUsd,
              leverage: existing.leverage,
            }
          : null,
        effectiveCrossEquity,
        effectiveCrossMaintUsed,
        hasCrossEquity,
        hasPoolMaint,
        newMaintAtMark,
        existingMaintAtMark,
        postFillPoolMaint,
        marginAvailableUsed,
        crossMaintenanceMarginUsedUsd,
        unifiedSpotUsdcBalanceUsd,
        unifiedTotalIsolatedMarginUsedUsd,
        unifiedTotalCrossMaintenanceMarginUsedUsd,
        debugCrossLiqInputs,
        estimatedLiq: liq,
      };
      console.log('[CrossLiqPreview]', debugPayload);
      console.log('[CrossLiqPreviewJSON]', JSON.stringify(debugPayload));
    }

    // TradeSimulator is a *simulator*: the user has explicitly chosen a side
    // and size here, so we always show the projected post-fill liq rather
    // than HL's reported liq for the existing position. That's what
    // distinguishes it from QuickTradeCard (dual-side widget, no committed
    // intent → matches Portfolio instead).
    const finalLiq = liq;

    return {
      estLiqPx: finalLiq === null ? null : Math.max(0, finalLiq),
      takerFeePct,
      makerFeePct,
      marginUsedUsd: Math.max(0, marginUsedUsd),
      orderValueUsd: usd,
    };
  }, [accountAbstractionMode, accountEquityUsd, builderFeeRate, crossMaintenanceMarginUsedUsd, debugCrossLiqInputs, entryPx, existingPosition, leverage, makerFeeRate, marginMode, marginTiers, orderType, side, sizeUnits, sizeUsd, takerFeeRate, unifiedSpotUsdcBalanceUsd, unifiedTotalCrossMaintenanceMarginUsedUsd, unifiedTotalIsolatedMarginUsedUsd]);

  return (
    <LinearGradient
      colors={['#1a1a2e', '#16213e', '#0f0f1a']}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[styles.card, isCalculating && styles.calculating]}
    >
      <View style={styles.titleRow}>
        <Text style={styles.title}>{isDemo ? t('demo.tradePreview') : t('trading.tradePreview')}</Text>
        {isLoading && <Text style={styles.loadingText}>{t('common.loading')}</Text>}
      </View>

      {hasLivePrice ? (
        <View style={styles.liveRow}>
          <View style={styles.liveLeft}>
            <LiveDot />
            <Text style={styles.liveLabel}>{t('trading.price')}</Text>
          </View>
          <View style={styles.valueWithHint}>
            <CurrencyHint usd={livePrice as number} placement="inline" />
            <Text
              style={[
                styles.liveValue,
                liveTint === 'up' && { color: colors.status.success },
                liveTint === 'down' && { color: colors.status.error },
              ]}
            >
              ${formatPriceSmart(livePrice as number)}
            </Text>
          </View>
        </View>
      ) : null}

      <View style={styles.row}>
        {!estLiqPx ? (
          <TouchableOpacity onPress={() => setShowLiquidationModal(true)} activeOpacity={0.7}>
            <DashedUnderline text={t('trading.estLiquidation')} textStyle={styles.label} />
          </TouchableOpacity>
        ) : (
          <Text style={styles.label}>Est. Liquidation</Text>
        )}
        <View style={styles.valueWithHint}>
          {estLiqPx ? <CurrencyHint usd={estLiqPx} placement="inline" /> : null}
          <Text style={[styles.value, { color: colors.status.error }]}>
            {estLiqPx ? `$${formatPriceSmart(estLiqPx)}` : 'N/A'}
          </Text>
        </View>
      </View>

      <View style={styles.row}>
        <Text style={styles.label}>{t('trading.orderValue')}</Text>
        <View style={styles.valueWithHint}>
          {orderValueUsd !== null ? <CurrencyHint usd={orderValueUsd} placement="inline" /> : null}
          <Text style={styles.value}>
            {orderValueUsd !== null ? `${orderValueUsd.toFixed(2)} USDC` : '--'}
          </Text>
        </View>
      </View>

      <View style={styles.row}>
        <Text style={styles.label}>{t('trading.marginRequired')}</Text>
        <View style={styles.valueWithHint}>
          {marginUsedUsd !== null ? <CurrencyHint usd={marginUsedUsd} placement="inline" /> : null}
          <Text style={styles.value}>{marginUsedUsd !== null ? `${marginUsedUsd.toFixed(2)} USDC` : '--'}</Text>
        </View>
      </View>

      <View style={styles.row}>
        <TouchableOpacity onPress={() => setShowFeesModal(true)} activeOpacity={0.7}>
          <DashedUnderline text={t('trading.fees')} textStyle={styles.label} />
        </TouchableOpacity>
        <Text style={styles.value}>
          {takerFeePct !== null && makerFeePct !== null ? `${takerFeePct.toFixed(4)}% / ${makerFeePct.toFixed(4)}%` : '--'}
        </Text>
      </View>

      {/* Fees Breakdown Modal */}
      <Modal
        visible={showFeesModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowFeesModal(false)}
      >
        <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setShowFeesModal(false)}>
          <TouchableOpacity style={styles.modalCard} activeOpacity={1}>
            <Text style={styles.modalTitle}>{t('trading.tradingFees')}</Text>
            <View style={styles.modalRow}>
              <Text style={styles.modalLabel}>{t('trading.takerFee')}:</Text>
              <Text style={styles.modalValue}>
                {takerFeePct !== null ? `${takerFeePct.toFixed(4)}%` : '--'}
              </Text>
            </View>
            <View style={styles.modalRow}>
              <Text style={styles.modalLabel}>{t('trading.makerFee')}:</Text>
              <Text style={styles.modalValue}>
                {makerFeePct !== null ? `${makerFeePct.toFixed(4)}%` : '--'}
              </Text>
            </View>
            <Text style={styles.modalText}>
              {t('trading.feesDescription')}
            </Text>
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.modalPrimary} onPress={() => setShowFeesModal(false)}>
                <Text style={styles.modalPrimaryText}>{t('common.gotIt')}</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Liquidation N/A Modal */}
      <Modal
        visible={showLiquidationModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowLiquidationModal(false)}
      >
        <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setShowLiquidationModal(false)}>
          <TouchableOpacity style={styles.modalCard} activeOpacity={1}>
            <Text style={styles.modalTitle}>{t('trading.liquidationPrice')}</Text>
            <Text style={styles.modalText}>
              {t('trading.liquidationPriceNotAvailable')}
            </Text>
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.modalPrimary} onPress={() => setShowLiquidationModal(false)}>
                <Text style={styles.modalPrimaryText}>{t('common.gotIt')}</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </LinearGradient>
  );
});

const styles = StyleSheet.create({
  card: {
    marginTop: 16,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  title: { 
    color: '#A0A0A0', 
    fontSize: 12, 
    fontWeight: '700', 
    textTransform: 'uppercase' 
  },
  titleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  loadingText: {
    color: colors.accent.gold,
    fontSize: 11,
    fontWeight: '600',
  },
  calculating: {
    opacity: 0.5,
  },
  row: { 
    flexDirection: 'row', 
    justifyContent: 'space-between', 
    marginBottom: 8 
  },
  liveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
    paddingHorizontal: 10,
    marginBottom: 10,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  liveLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  liveLabel: {
    color: colors.text.secondary,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  liveValue: {
    color: colors.text.primary,
    fontSize: 15,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  label: { color: '#888', fontSize: 14 },
  valueWithHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    flexShrink: 1,
    justifyContent: 'flex-end',
  },
  feesLabelContainer: {
    position: 'relative',
  },
  dashedUnderline: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    height: 1,
    alignItems: 'center',
  },
  dash: {
    width: 4,
    height: 1,
    backgroundColor: '#888',
  },
  value: { color: '#FFF', fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
  note: { marginTop: 8, color: '#555', fontSize: 10 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    padding: 20,
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
    marginBottom: 8,
  },
  modalText: {
    color: colors.text.secondary,
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 12,
  },
  modalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
  },
  modalLabel: {
    color: colors.text.tertiary,
    fontSize: 12,
    fontWeight: '700',
  },
  modalValue: {
    color: colors.text.primary,
    fontSize: 12,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  modalButtons: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 14,
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
});