import React, { useEffect, useMemo, useCallback, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, FlatList, ActivityIndicator, Modal, Platform, Image, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useDisplayCurrency } from '../src/providers/CurrencyProvider';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { PnlShareExportFrame } from '../src/components/PnlShareExportFrame';
import { sharePnlPng } from '../src/lib/sharePnlImage';

import ViewShot from 'react-native-view-shot';
import MaskedView from '@react-native-masked-view/masked-view';
import { LinearGradient } from 'expo-linear-gradient';
import { colors } from '../src/theme/colors';
import { useAuth } from '../src/providers/AuthContext';
import { getUserFills, getSpotSymbolMap } from '../src/lib/hyperliquid';
import { showToast } from '../src/lib/toast';
import { useAppStore } from '../src/store/appStore';
import { formatDisplaySymbol as formatAppDisplaySymbol } from '../src/lib/displaySymbols';
import {
  aiAgentCloidPrefix,
  isAiAgentCloid,
  matchAiAgentIdFromCloid,
} from '../src/lib/aiAgentCloid';
import { listAiAgents, type AiAgentView } from '../src/lib/api';

type Hex = `0x${string}`;

const INITIAL_DISPLAY_COUNT = 7;
const LOAD_MORE_COUNT = 10;

export default function TradeHistoryScreen() {
  const { t } = useTranslation();
  const dc = useDisplayCurrency();
  const router = useRouter();
  const params = useLocalSearchParams<{ symbol?: string }>();
  const { isAuthenticated, isReady, walletAddress, getAccessToken } = useAuth();
  const tradingEnv = useAppStore((s) => s.tradingEnv);
  const queryClient = useQueryClient();
  const [pnlShareModal, setPnlShareModal] = useState<null | {
    symbol: string;
    direction: 'LONG' | 'SHORT';
    pnlPercent: number;
    entryPrice: number;
    markPrice: number;
  }>(null);
  const [pnlShareLoading, setPnlShareLoading] = useState(false);
  const pnlShareRef = useRef<React.ElementRef<typeof ViewShot> | null>(null);
  const [displayCount, setDisplayCount] = useState(INITIAL_DISPLAY_COUNT);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(params.symbol || null);
  // Perp vs Spot segment filter. Users with both a perp and a spot HYPE
  // position would otherwise see two "HYPE" chips (raw coins diverge:
  // perp=`HYPE`, spot=`@107`). Segmenting lets them narrow the list and
  // dedupes the symbol chips to one entry per display symbol per market.
  const [marketFilter, setMarketFilter] = useState<'all' | 'perp' | 'spot'>('all');

  useEffect(() => {
    if (isReady && !isAuthenticated) {
      router.replace('/login');
    }
  }, [isAuthenticated, isReady, router]);

  if (!isReady) {
    return <SafeAreaView style={styles.container} />;
  }

  const userAddress = (walletAddress || '') as Hex;

  const { data: userFills, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['hl_user_fills_history', tradingEnv, userAddress],
    queryFn: () => getUserFills(userAddress),
    enabled: !!userAddress && userAddress.startsWith('0x'),
    refetchInterval: 15000,
  });

  const { data: aiAgents = [] } = useQuery({
    queryKey: ['ai_agents', 'trade_history', tradingEnv],
    queryFn: async () => {
      const token = await getAccessToken();
      if (!token) return [] as AiAgentView[];
      return (await listAiAgents(token)).agents;
    },
    enabled: isAuthenticated,
    staleTime: 60_000,
  });

  const dedicatedAgents = useMemo(() => {
    const isDemo = tradingEnv === 'demo';
    return aiAgents.filter(
      (a) =>
        a.mode === 'dedicated' &&
        !!a.hlSubaccountAddress &&
        (a.tradingEnv === 'demo') === isDemo,
    );
  }, [aiAgents, tradingEnv]);

  const dedicatedFillQueries = useQueries({
    queries: dedicatedAgents.map((a) => ({
      queryKey: ['hl_user_fills_history', tradingEnv, a.hlSubaccountAddress],
      queryFn: () => getUserFills(a.hlSubaccountAddress as Hex),
      enabled: !!a.hlSubaccountAddress,
      refetchInterval: 15_000,
    })),
  });

  const { data: cloidPrefixes = [] } = useQuery({
    queryKey: ['ai_agent_cloid_prefixes', aiAgents.map((a) => a.id).join(',')],
    queryFn: () =>
      Promise.all(
        aiAgents.map(async (a) => ({
          agentId: a.id,
          prefix: await aiAgentCloidPrefix(a.id),
        })),
      ),
    enabled: aiAgents.length > 0,
    staleTime: Infinity,
  });

  const agentsById = useMemo(() => {
    const map = new Map<string, AiAgentView>();
    for (const a of aiAgents) map.set(a.id, a);
    return map;
  }, [aiAgents]);

  const { data: spotSymbolMap } = useQuery({
    queryKey: ['hl_spot_symbol_map', tradingEnv],
    queryFn: () => getSpotSymbolMap(),
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
  });

  const fills = useMemo(() => {
    const nameForCloid = (cloid: unknown, dedicatedName?: string | null) => {
      if (!isAiAgentCloid(cloid)) return null;
      if (dedicatedName) return dedicatedName;
      const id = matchAiAgentIdFromCloid(cloid, cloidPrefixes);
      return id ? (agentsById.get(id)?.name ?? null) : null;
    };
    const tagged: any[] = [];
    for (const f of (userFills ?? []) as any[]) {
      tagged.push({
        ...f,
        _agentName: nameForCloid(f.cloid ?? f.c),
      });
    }
    dedicatedAgents.forEach((agent, idx) => {
      const rows = (dedicatedFillQueries[idx]?.data ?? []) as any[];
      for (const f of rows) {
        tagged.push({
          ...f,
          _agentName: nameForCloid(f.cloid ?? f.c, agent.name),
        });
      }
    });
    tagged.sort((a, b) => {
      const ta = Number(a.time ?? a.timestamp ?? 0);
      const tb = Number(b.time ?? b.timestamp ?? 0);
      return tb - ta;
    });
    return tagged;
  }, [userFills, dedicatedAgents, dedicatedFillQueries, cloidPrefixes, agentsById]);

  const formatDisplaySymbol = useCallback((coin: string) => {
    return formatAppDisplaySymbol(coin, spotSymbolMap);
  }, [spotSymbolMap]);

  const isSpotFillCoin = useCallback((coin: string) => coin.startsWith('@'), []);

  // Market-scoped fills. Applied before symbol extraction so the symbol
  // chips are themselves scoped to the current market, which avoids stale
  // selections like "HYPE (spot)" staying active after switching to Perps.
  const marketScopedFills = useMemo(() => {
    if (marketFilter === 'all') return fills;
    return fills.filter((f: any) => {
      const coin = String(f.coin ?? f.symbol ?? f.asset ?? '');
      const isSpot = isSpotFillCoin(coin);
      return marketFilter === 'spot' ? isSpot : !isSpot;
    });
  }, [fills, isSpotFillCoin, marketFilter]);

  // Unique symbols for filter chips, deduped by DISPLAY symbol. HYPE perp
  // (`HYPE`) and HYPE spot (`@107`) both show the same label; the chip
  // "HYPE" should represent the one in the current market segment. We key
  // by display symbol and keep the first raw coin we see for that display.
  const uniqueSymbols = useMemo(() => {
    const byDisplay = new Map<string, string>();
    marketScopedFills.forEach((f: any) => {
      const coin = String(f.coin ?? f.symbol ?? f.asset ?? '');
      if (!coin) return;
      const display = formatDisplaySymbol(coin);
      if (!display) return;
      if (!byDisplay.has(display)) byDisplay.set(display, coin);
    });
    return Array.from(byDisplay.values()).sort((a, b) => {
      const da = formatDisplaySymbol(a);
      const db = formatDisplaySymbol(b);
      return da.localeCompare(db);
    });
  }, [marketScopedFills, formatDisplaySymbol]);

  // Clear an orphaned symbol selection when the market filter changes and
  // the previously-selected symbol no longer appears in the visible set.
  useEffect(() => {
    if (!selectedSymbol) return;
    const selDisplay = formatDisplaySymbol(selectedSymbol);
    const stillVisible = uniqueSymbols.some((s) => formatDisplaySymbol(s) === selDisplay);
    if (!stillVisible) setSelectedSymbol(null);
  }, [selectedSymbol, uniqueSymbols, formatDisplaySymbol]);

  // Filtered fills: apply market segment AND symbol filter. The symbol
  // match compares display symbols so "HYPE" matches both `HYPE` (perp)
  // and `@107` (spot) — scoping is already enforced by `marketScopedFills`.
  const filteredFills = useMemo(() => {
    if (!selectedSymbol) return marketScopedFills;
    const target = formatDisplaySymbol(selectedSymbol);
    return marketScopedFills.filter((f: any) => {
      const coin = String(f.coin ?? f.symbol ?? f.asset ?? '');
      return coin === selectedSymbol || formatDisplaySymbol(coin) === target;
    });
  }, [marketScopedFills, formatDisplaySymbol, selectedSymbol]);

  // Paginated display
  const displayedFills = useMemo(() => {
    return filteredFills.slice(0, displayCount);
  }, [filteredFills, displayCount]);

  const hasMore = displayCount < filteredFills.length;

  const handleShowMore = useCallback(() => {
    setDisplayCount((prev) => prev + LOAD_MORE_COUNT);
  }, []);

  const handleRefresh = useCallback(() => {
    setDisplayCount(INITIAL_DISPLAY_COUNT);
    void refetch();
    void queryClient.invalidateQueries({ queryKey: ['hl_user_fills_history'] });
  }, [refetch, queryClient]);

  const handleSymbolFilter = useCallback((symbol: string | null) => {
    setSelectedSymbol(symbol);
    setDisplayCount(INITIAL_DISPLAY_COUNT); // Reset pagination when filter changes
  }, []);

  const safeNum = (x: any) => {
    const n = typeof x === 'number' ? x : parseFloat(String(x ?? ''));
    return Number.isFinite(n) ? n : NaN;
  };

  const formatPriceNum = (n: number | null | undefined): string => {
    if (n === null || n === undefined || !Number.isFinite(n)) return '--';
    return dc.formatDisplayPrice(n);
  };

  const formatSignedUsd = (n: number): string => {
    if (!Number.isFinite(n)) return '--';
    return dc.formatDisplaySigned(n);
  };

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
        showToast('Failed to generate image');
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

  const renderItem = useCallback(({ item, index }: { item: any; index: number }) => {
    const coin = String(item.coin ?? item.symbol ?? item.asset ?? '--');
    const displayCoin = formatDisplaySymbol(coin);
    const isSpotFill = coin.startsWith('@');
    const sideRaw = String(item.side ?? item.dir ?? item.orderSide ?? '').toLowerCase();
    const isBuy = sideRaw === 'b' || sideRaw === 'buy' || sideRaw === 'long';
    const sideLabel = sideRaw ? (isBuy ? t('trading.buy') : t('trading.sell')) : '--';
    const pxNum = safeNum(item.px ?? item.price ?? item.fillPx);
    const szNum = safeNum(item.sz ?? item.size ?? item.qty);
    let feeNum = safeNum(item.fee ?? item.fees);
    // Convert fee to USD if it's in a token (for spot buy orders)
    // Sell orders have fee in USDC, buy orders have fee in the asset token
    if (Number.isFinite(feeNum) && isSpotFill && item.feeToken && item.feeToken !== 'USDC') {
      // Fee is in the asset token, convert to USD by multiplying by price
      if (Number.isFinite(pxNum)) {
        feeNum = feeNum * pxNum;
      }
    }
    const pnlNum = safeNum(item.pnl ?? item.realizedPnl ?? item.pnlUsd ?? item.closedPnl);
    // HL fills separate fee from pnl; show net PnL so opens aren't misleadingly 0.
    const netPnlNum = Number.isFinite(pnlNum)
      ? pnlNum - (Number.isFinite(feeNum) ? feeNum : 0)
      : (Number.isFinite(feeNum) ? -feeNum : NaN);
    const timeStr = formatShortTime(item.time ?? item.timestamp);
    const tradeValueUsd = Number.isFinite(pxNum) && Number.isFinite(szNum) ? Math.abs(pxNum * szNum) : NaN;
    const rowKey = item.oid ?? item.tid ?? `${coin}:${item.time ?? 't'}:${index}`;
    const pnlPercentForShare = Number.isFinite(netPnlNum) && Number.isFinite(tradeValueUsd) && tradeValueUsd > 0
      ? (netPnlNum / tradeValueUsd) * 100
      : 0;
    const isAiFill = !isSpotFill && isAiAgentCloid(item.cloid ?? item.c);
    const agentName = typeof item._agentName === 'string' && item._agentName.trim() ? item._agentName.trim() : null;

    return (
      <View key={rowKey} style={[styles.row, index === 0 && styles.rowFirst]}>
        <View style={styles.rowTop}>
          <View style={styles.rowTitle}>
            {isAiFill ? (
              <View style={styles.aiAgentBadge}>
                <MaterialCommunityIcons name="robot-outline" size={13} color={colors.accent.gold} />
                {agentName ? (
                  <Text style={styles.aiAgentName} numberOfLines={1}>
                    {agentName}
                  </Text>
                ) : null}
              </View>
            ) : null}
            <Text style={styles.coin}>{displayCoin}</Text>
            {/* Small Perp/Spot marker so users with both books can tell them
                apart even when the All filter is active. */}
            <View style={[styles.marketPill, isSpotFill ? styles.marketPillSpot : styles.marketPillPerp]}>
              <Text style={[styles.marketPillText, isSpotFill ? styles.marketPillTextSpot : styles.marketPillTextPerp]}>
                {isSpotFill ? t('trading.spot') : t('portfolio.perp')}
              </Text>
            </View>
            <View style={[styles.sidePill, isBuy ? styles.sidePillLong : styles.sidePillShort]}>
              <Text style={[styles.sidePillText, isBuy ? styles.sidePillTextLong : styles.sidePillTextShort]}>{sideLabel}</Text>
            </View>
          </View>
        </View>
        <View style={styles.metricsGrid}>
          <View style={styles.metricItem}>
            <Text style={styles.metricLabel}>{t('trading.price')}</Text>
            <Text style={styles.metricValue}>{formatPriceNum(pxNum)}</Text>
          </View>
          <View style={styles.metricItem}>
            <Text style={styles.metricLabel}>{t('tradeHistory.tradeValue')}</Text>
            <Text style={styles.metricValue}>{Number.isFinite(tradeValueUsd) ? `${tradeValueUsd.toFixed(2)} USDC` : '--'}</Text>
          </View>
          <View style={styles.metricItem}>
            <Text style={styles.metricLabel}>{t('tradeHistory.fee')}</Text>
            <Text style={styles.metricValue}>{Number.isFinite(feeNum) ? formatSignedUsd(feeNum) : '--'}</Text>
          </View>
          <View style={styles.metricItem}>
            <Text style={styles.metricLabel}>{t('tradeHistory.time')}</Text>
            <Text style={styles.metricValue}>{timeStr}</Text>
          </View>
        </View>
      </View>
    );
  }, [formatDisplaySymbol, pnlShareLoading, t]);

  if (!isAuthenticated) {
    return <SafeAreaView style={styles.container} />;
  }

  return (
    <SafeAreaView style={styles.container}>
      <Modal visible={!!pnlShareModal} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.pnlModalCard}>
            <View style={styles.pnlModalHeader}>
              <Text style={styles.headerTitle}>{t('tradeHistory.sharePnl')}</Text>
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
            <Text style={styles.pnlHint}>{t('tradeHistory.imageGeneratedOnDevice')}</Text>
          </View>
        </View>
      </Modal>

      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={22} color={colors.text.primary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('tradeHistory.title')}</Text>
        <TouchableOpacity onPress={handleRefresh} style={styles.refreshButton}>
          {isRefetching ? (
            <ActivityIndicator size="small" color={colors.accent.gold} />
          ) : (
            <Ionicons name="refresh" size={18} color={colors.text.tertiary} />
          )}
        </TouchableOpacity>
      </View>

      {/* Filters: market segment + symbol chips */}
      {!isLoading && fills.length > 0 && (
        <View style={styles.filterSection}>
          {/* Market segment — rendered only when the user actually has both
              perp and spot fills; otherwise it's noise. */}
          {(() => {
            const hasPerp = fills.some((f: any) => !isSpotFillCoin(String(f.coin ?? f.symbol ?? f.asset ?? '')));
            const hasSpot = fills.some((f: any) => isSpotFillCoin(String(f.coin ?? f.symbol ?? f.asset ?? '')));
            if (!(hasPerp && hasSpot)) return null;
            const segments: Array<{ id: 'all' | 'perp' | 'spot'; label: string }> = [
              { id: 'all', label: t('home.all') },
              { id: 'perp', label: t('portfolio.perp') },
              { id: 'spot', label: t('trading.spot') },
            ];
            return (
              <View style={styles.marketSegmentRow}>
                {segments.map((seg) => {
                  const active = marketFilter === seg.id;
                  return (
                    <TouchableOpacity
                      key={seg.id}
                      style={[styles.marketSegment, active && styles.marketSegmentActive]}
                      onPress={() => {
                        setMarketFilter(seg.id);
                        setDisplayCount(INITIAL_DISPLAY_COUNT);
                      }}
                    >
                      <Text style={[styles.marketSegmentText, active && styles.marketSegmentTextActive]}>
                        {seg.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            );
          })()}
          {uniqueSymbols.length > 1 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterChipsContainer}>
              <TouchableOpacity
                style={[styles.filterChip, !selectedSymbol && styles.filterChipActive]}
                onPress={() => handleSymbolFilter(null)}
              >
                <Text style={[styles.filterChipText, !selectedSymbol && styles.filterChipTextActive]}>
                  {t('portfolio.allSymbols')}
                </Text>
              </TouchableOpacity>
              {uniqueSymbols.map((symbol) => (
                <TouchableOpacity
                  key={symbol}
                  style={[styles.filterChip, selectedSymbol === symbol && styles.filterChipActive]}
                  onPress={() => handleSymbolFilter(symbol)}
                >
                  <Text style={[styles.filterChipText, selectedSymbol === symbol && styles.filterChipTextActive]}>{formatDisplaySymbol(symbol)}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}
        </View>
      )}

      {isLoading ? (
        <View style={styles.loading}>
          <ActivityIndicator size="large" color={colors.accent.gold} />
          <Text style={styles.loadingText}>{t('tradeHistory.loading')}</Text>
        </View>
      ) : filteredFills.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>
            {selectedSymbol ? t('tradeHistory.noTradesForSymbol', { symbol: formatDisplaySymbol(selectedSymbol) }) : t('tradeHistory.noTradeHistoryYet')}
          </Text>
          <Text style={styles.emptySubtext}>{selectedSymbol ? t('tradeHistory.tryDifferentSymbol') : t('tradeHistory.tradesWillAppear')}</Text>
        </View>
      ) : (
        <FlatList
          data={displayedFills}
          keyExtractor={(item, index) => String(item.oid ?? item.tid ?? `${item.coin ?? 'c'}:${item.time ?? 't'}:${index}`)}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          initialNumToRender={10}
          maxToRenderPerBatch={10}
          windowSize={5}
          removeClippedSubviews
          ListFooterComponent={
            hasMore ? (
              <TouchableOpacity style={styles.showMoreButton} onPress={handleShowMore}>
                <Text style={styles.showMoreText}>
                  {t('tradeHistory.showMoreRemaining', { count: filteredFills.length - displayCount })}
                </Text>
                <Ionicons name="chevron-down" size={16} color={colors.accent.gold} />
              </TouchableOpacity>
            ) : filteredFills.length > INITIAL_DISPLAY_COUNT ? (
              <Text style={styles.endOfListText}>
                {selectedSymbol ? t('tradeHistory.endOfHistoryForSymbol', { symbol: formatDisplaySymbol(selectedSymbol) }) : t('tradeHistory.endOfHistory')}
              </Text>
            ) : null
          }
        />
      )}
    </SafeAreaView>
  );
}

type PnlShareCardProps = {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  pnlPercent: number;
  entryPrice: number;
  markPrice: number;
};

const PnlShareCard = ({ symbol, direction, pnlPercent, entryPrice, markPrice }: PnlShareCardProps) => {
  const { formatDisplayPrice: fmtPx } = useDisplayCurrency();
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
          <Text style={styles.pnlPriceLabel}>Entry Price</Text>
          <Text style={styles.pnlPriceValue}>{fmtPx(entryPrice)}</Text>
        </View>
        <View style={styles.pnlPriceCol}>
          <Text style={styles.pnlPriceLabel}>Mark Price</Text>
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
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border.primary },
  headerTitle: { fontSize: 16, fontWeight: '800', color: colors.text.primary },
  backButton: { padding: 6 },
  refreshButton: { padding: 6 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  loadingText: { marginTop: 10, fontSize: 13, color: colors.text.tertiary },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  emptyText: { fontSize: 15, fontWeight: '700', color: colors.text.primary },
  emptySubtext: { marginTop: 6, fontSize: 12, color: colors.text.tertiary, textAlign: 'center' },
  listContent: { padding: 12, paddingBottom: 24 },
  row: { paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.border.primary },
  rowFirst: { borderTopWidth: 0 },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowTitle: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  aiAgentBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    maxWidth: 112,
    paddingHorizontal: 4,
    paddingVertical: 2,
    borderRadius: 5,
    backgroundColor: 'rgba(92,225,230,0.12)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.accent.goldDark,
  },
  aiAgentName: {
    color: colors.accent.gold,
    fontSize: 10,
    fontWeight: '800',
    flexShrink: 1,
  },
  coin: { color: colors.text.primary, fontSize: 13, fontWeight: '800' },
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
  pnlInlineRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pnlInlineButton: {
    paddingVertical: 4,
    paddingHorizontal: 6,
    borderRadius: 8,
    backgroundColor: colors.background.tertiary,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },

  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', padding: 20 },
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

  showMoreButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    marginTop: 4,
    gap: 6,
  },
  showMoreText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.accent.gold,
  },
  endOfListText: {
    fontSize: 12,
    color: colors.text.tertiary,
    textAlign: 'center',
    paddingVertical: 16,
  },

  filterSection: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border.primary,
  },
  filterChipsContainer: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  filterChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: colors.background.tertiary,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  filterChipActive: {
    backgroundColor: `${colors.accent.gold}20`,
    borderColor: colors.accent.gold,
  },
  filterChipText: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.text.secondary,
  },
  filterChipTextActive: {
    color: colors.accent.gold,
  },
  marketSegmentRow: {
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 2,
  },
  marketSegment: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border.primary,
    backgroundColor: colors.background.tertiary,
  },
  marketSegmentActive: {
    backgroundColor: colors.accent.gold,
    borderColor: colors.accent.gold,
  },
  marketSegmentText: {
    fontSize: 12,
    fontWeight: '800',
    color: colors.text.secondary,
  },
  marketSegmentTextActive: {
    color: colors.background.primary,
  },
  marketPill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
    borderWidth: 1,
  },
  marketPillPerp: {
    backgroundColor: `${colors.accent.gold}14`,
    borderColor: `${colors.accent.gold}40`,
  },
  marketPillSpot: {
    backgroundColor: 'rgba(59, 130, 246, 0.12)',
    borderColor: 'rgba(59, 130, 246, 0.45)',
  },
  marketPillText: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  marketPillTextPerp: {
    color: colors.accent.gold,
  },
  marketPillTextSpot: {
    color: '#3B82F6',
  },
});
