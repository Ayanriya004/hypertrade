import { useMemo, useRef } from 'react';
import { useQuery, useQueries } from '@tanstack/react-query';
import { useAppStore } from '../store/appStore';
import { getHyperliquidTradingState, type HyperliquidTradingState } from '../lib/hyperliquid';
import { useActiveTradingBook } from './useActiveTradingBook';

export function formatBookNameWithLiveCount(name: string, liveCount: number | undefined): string {
  if (!liveCount || liveCount < 1) return name;
  return `${name} (${liveCount})`;
}

function livePerpCount(state: HyperliquidTradingState | undefined): number {
  const live = (state?.positions ?? []).filter((p) => Math.abs(Number(p.szi)) > 0).length;
  if (live > 0) return live;
  const fallback = Number(state?.perpPositionsCount);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 0;
}

function reuseCountMap(prev: Map<string, number>, next: Map<string, number>): Map<string, number> {
  if (prev.size !== next.size) return next;
  for (const [id, count] of next) {
    if (prev.get(id) !== count) return next;
  }
  return prev;
}

export type DedicatedBookCountTarget = { id: string; subAddress: string };

/**
 * Live perp positions on each Dedicated sub-account (AI + manual).
 * Shares Portfolio/Home `['hl_trading_state', env, address]` cache.
 */
export function useDedicatedBookLivePositionCounts(
  books: DedicatedBookCountTarget[],
  enabled = true,
): Map<string, number> {
  const tradingEnv = useAppStore((s) => s.tradingEnv);
  const results = useQueries({
    queries: books.map((b) => ({
      queryKey: ['hl_trading_state', tradingEnv, b.subAddress] as const,
      queryFn: () => getHyperliquidTradingState(b.subAddress as `0x${string}`),
      enabled: enabled && !!b.subAddress,
      staleTime: 15_000,
      refetchInterval: 30_000,
    })),
  });

  const prevRef = useRef<Map<string, number>>(new Map());
  const signature = books
    .map((b, i) => `${b.id}:${livePerpCount(results[i]?.data)}`)
    .join('|');

  return useMemo(() => {
    const map = new Map<string, number>();
    for (let i = 0; i < books.length; i++) {
      const n = livePerpCount(results[i]?.data);
      if (n > 0) map.set(books[i].id, n);
    }
    const kept = reuseCountMap(prevRef.current, map);
    prevRef.current = kept;
    return kept;
    // signature captures count changes; books length/ids are encoded in it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
}

/** Live perp positions on Main — manual + Shared agents. */
export function useMasterBookLivePositionCount(enabled = true): number {
  const tradingEnv = useAppStore((s) => s.tradingEnv);
  const { masterAddress } = useActiveTradingBook();

  const { data } = useQuery({
    queryKey: ['hl_trading_state', tradingEnv, masterAddress],
    queryFn: () => getHyperliquidTradingState(masterAddress!),
    enabled: enabled && !!masterAddress,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  return useMemo(() => livePerpCount(data), [data]);
}
