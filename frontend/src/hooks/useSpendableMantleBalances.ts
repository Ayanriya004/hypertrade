/**
 * Batch-read Mantle `*24` fiat token balances for the URID-owning EOA.
 *
 * Uses a shared module cache + stale-while-revalidate so opening Convert
 * after the Cash tab does not cold-start `/ur/fx/info` + 8 RPC calls again.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  fetchSpendableMantleBalances,
  getCachedSpendableBalances,
  invalidateSpendableMantleBalances,
  isBalanceCacheFresh,
  type BalanceCacheEntry,
} from '../lib/spendableMantleBalanceCache';
import {
  MANTLE_MAINNET_CHAIN_ID,
  MANTLE_SEPOLIA_CHAIN_ID,
  ZERO_SPENDABLE,
  type SpendableFiatBalance,
} from '../lib/mantleFiatBalance';

export type { SpendableFiatBalance };
export {
  warmSpendableMantleBalances,
  invalidateSpendableMantleBalances,
} from '../lib/spendableMantleBalanceCache';

export type PickerBalanceOption = {
  currency: string;
  amount: number;
  amountStr: string;
  balanceLoading?: boolean;
};

export function useSpendableMantleBalances({
  active,
  walletAddress,
  getAccessToken,
}: {
  active: boolean;
  walletAddress: string | undefined | null;
  getAccessToken: () => Promise<string | null>;
}) {
  const [byCurrency, setByCurrency] = useState<Record<string, SpendableFiatBalance>>({});
  const [chainId, setChainId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [revalidating, setRevalidating] = useState(false);
  const [error, setError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const revalidateInflightRef = useRef<Promise<void> | null>(null);

  const applyEntry = useCallback((entry: BalanceCacheEntry) => {
    setChainId(entry.chainId);
    setByCurrency(entry.byCurrency);
    setError(false);
  }, []);

  useEffect(() => {
    if (!active || !walletAddress) {
      setByCurrency({});
      setChainId(null);
      setLoading(false);
      setRevalidating(false);
      setError(false);
      return;
    }

    let cancelled = false;
    const wallet = walletAddress;

    // Show any still-valid stale cache immediately (e.g. warmed on Cash tab).
    const staleCandidates: BalanceCacheEntry[] = [];
    for (const id of [MANTLE_SEPOLIA_CHAIN_ID, MANTLE_MAINNET_CHAIN_ID]) {
      const hit = getCachedSpendableBalances(id, wallet);
      if (hit) staleCandidates.push(hit);
    }
    const bestStale = staleCandidates.sort((a, b) => b.fetchedAt - a.fetchedAt)[0];
    if (bestStale) {
      applyEntry(bestStale);
      if (isBalanceCacheFresh(bestStale)) {
        setLoading(false);
        setRevalidating(false);
        return;
      }
      setLoading(false);
      setRevalidating(true);
    } else {
      setByCurrency({});
      setLoading(true);
      setRevalidating(false);
      setError(false);
    }

    void (async () => {
      try {
        const entry = await fetchSpendableMantleBalances(getAccessToken, wallet, {
          force: refreshKey > 0,
        });
        if (!cancelled) applyEntry(entry);
      } catch (err) {
        if (__DEV__) {
          // eslint-disable-next-line no-console
          console.log('[useSpendableMantleBalances] failed', err);
        }
        if (!cancelled && !bestStale) {
          setError(true);
          setByCurrency({});
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          setRevalidating(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [active, walletAddress, getAccessToken, refreshKey, applyEntry]);

  const ready = !error && Object.keys(byCurrency).length > 0;

  const refresh = useCallback(() => {
    if (walletAddress) invalidateSpendableMantleBalances(walletAddress);
    setRefreshKey((k) => k + 1);
  }, [walletAddress]);

  /** Force a fresh on-chain read (bypasses the 30s fresh cache). */
  const revalidate = useCallback(async () => {
    if (!active || !walletAddress) return;
    if (revalidateInflightRef.current) {
      await revalidateInflightRef.current;
      return;
    }
    const job = (async () => {
      setRevalidating(true);
      try {
        const entry = await fetchSpendableMantleBalances(getAccessToken, walletAddress, {
          force: true,
        });
        applyEntry(entry);
      } catch (err) {
        if (__DEV__) {
          // eslint-disable-next-line no-console
          console.log('[useSpendableMantleBalances] revalidate failed', err);
        }
      } finally {
        setRevalidating(false);
        revalidateInflightRef.current = null;
      }
    })();
    revalidateInflightRef.current = job;
    await job;
  }, [active, walletAddress, getAccessToken, applyEntry]);

  const forCurrency = useCallback(
    (code: string): SpendableFiatBalance | null => {
      if (!ready) return null;
      return byCurrency[code.toUpperCase()] ?? ZERO_SPENDABLE;
    },
    [ready, byCurrency],
  );

  const decoratePickerOptions = useCallback(
    <T extends { currency: string; amount: number; amountStr: string }>(
      options: T[],
    ): (T & { balanceLoading?: boolean })[] => {
      if (!ready) {
        return options.map((o) => ({ ...o, balanceLoading: loading || revalidating }));
      }
      return options.map((o) => {
        const spendable = byCurrency[o.currency.toUpperCase()] ?? ZERO_SPENDABLE;
        return {
          ...o,
          amount: spendable.amount,
          amountStr: spendable.amountStr,
          balanceLoading: revalidating,
        };
      });
    },
    [ready, loading, revalidating, byCurrency],
  );

  const balanceLocked = useMemo(
    () => (loading && !ready) || (error && !ready),
    [loading, error, ready],
  );

  return {
    loading: loading && !ready,
    revalidating,
    error: error && !ready,
    ready,
    balanceLocked,
    chainId,
    refresh,
    revalidate,
    byCurrency,
    forCurrency,
    decoratePickerOptions,
  };
}
