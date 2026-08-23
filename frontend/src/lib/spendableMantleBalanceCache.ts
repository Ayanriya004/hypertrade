/**
 * Shared in-memory cache for Mantle spendable balances + FX token map.
 * Lets every banking sheet reuse one `/ur/fx/info` + RPC batch instead of
 * cold-starting on each open.
 */
import type { Hex } from 'viem';

import { fetchUrFxInfo } from './urApi';
import {
  ERC20_BALANCE_ABI,
  getMantlePublicClient,
  spendableFromRaw,
  tokenKeyToFiatSymbol,
  type SpendableFiatBalance,
} from './mantleFiatBalance';

const FX_TTL_MS = 5 * 60_000;
/** Balances younger than this are served without a network round-trip. */
const BALANCE_FRESH_MS = 30_000;
/** Stale balances may still display while a silent refresh runs. */
const BALANCE_STALE_MS = 3 * 60_000;

type FxCacheEntry = {
  chainId: number;
  fiatTokens: Record<string, string>;
  fetchedAt: number;
};

export type BalanceCacheEntry = {
  chainId: number;
  byCurrency: Record<string, SpendableFiatBalance>;
  fetchedAt: number;
};

let fxCache: FxCacheEntry | null = null;
let fxInflight: Promise<FxCacheEntry> | null = null;
const balanceCache = new Map<string, BalanceCacheEntry>();
const balanceInflight = new Map<string, Promise<BalanceCacheEntry>>();

function balanceCacheKey(chainId: number, wallet: string): string {
  return `${chainId}:${wallet.toLowerCase()}`;
}

export function getCachedSpendableBalances(
  chainId: number,
  wallet: string,
): BalanceCacheEntry | null {
  const hit = balanceCache.get(balanceCacheKey(chainId, wallet));
  if (!hit) return null;
  if (Date.now() - hit.fetchedAt > BALANCE_STALE_MS) {
    balanceCache.delete(balanceCacheKey(chainId, wallet));
    return null;
  }
  return hit;
}

export function isBalanceCacheFresh(entry: BalanceCacheEntry): boolean {
  return Date.now() - entry.fetchedAt < BALANCE_FRESH_MS;
}

export function invalidateSpendableMantleBalances(wallet?: string): void {
  if (!wallet) {
    balanceCache.clear();
    return;
  }
  const target = wallet.toLowerCase();
  for (const key of balanceCache.keys()) {
    if (key.endsWith(`:${target}`)) balanceCache.delete(key);
  }
}

export async function fetchMantleFxInfoCached(
  getAccessToken: () => Promise<string | null>,
  { force = false } = {},
): Promise<FxCacheEntry> {
  if (!force && fxCache && Date.now() - fxCache.fetchedAt < FX_TTL_MS) {
    return fxCache;
  }
  if (!force && fxInflight) return fxInflight;

  fxInflight = (async () => {
    const token = await getAccessToken();
    if (!token) throw new Error('Not authenticated');
    const info = await fetchUrFxInfo(token);
    const entry: FxCacheEntry = {
      chainId: info.chain_id,
      fiatTokens: info.fiat_tokens ?? {},
      fetchedAt: Date.now(),
    };
    if (!Object.keys(entry.fiatTokens).length) {
      throw new Error('No fiat tokens configured for Mantle FX');
    }
    fxCache = entry;
    return entry;
  })();

  try {
    return await fxInflight;
  } finally {
    fxInflight = null;
  }
}

async function readBalancesOnChain(
  chainId: number,
  wallet: string,
  fiatTokens: Record<string, string>,
): Promise<Record<string, SpendableFiatBalance>> {
  const owner = wallet as Hex;
  const client = getMantlePublicClient(chainId);
  const entries = Object.entries(fiatTokens);

  const results = await Promise.allSettled(
    entries.map(([, addr]) =>
      client.readContract({
        address: addr as Hex,
        abi: ERC20_BALANCE_ABI,
        functionName: 'balanceOf',
        args: [owner],
      }),
    ),
  );

  const next: Record<string, SpendableFiatBalance> = {};
  for (let i = 0; i < entries.length; i++) {
    const [sym] = entries[i];
    const row = results[i];
    if (row.status === 'fulfilled') {
      next[tokenKeyToFiatSymbol(sym)] = spendableFromRaw(row.value);
    } else if (__DEV__) {
      // eslint-disable-next-line no-console
      console.log('[SpendableMantleBalances] balanceOf failed', sym, row.reason);
    }
  }

  if (!Object.keys(next).length) {
    throw new Error('All Mantle balance reads failed');
  }
  return next;
}

export async function fetchSpendableMantleBalances(
  getAccessToken: () => Promise<string | null>,
  wallet: string,
  { force = false } = {},
): Promise<BalanceCacheEntry> {
  const fx = await fetchMantleFxInfoCached(getAccessToken, { force });
  const key = balanceCacheKey(fx.chainId, wallet);

  if (!force) {
    const cached = getCachedSpendableBalances(fx.chainId, wallet);
    if (cached && isBalanceCacheFresh(cached)) return cached;
  }

  const inflight = balanceInflight.get(key);
  if (!force && inflight) return inflight;

  const job = (async () => {
    const byCurrency = await readBalancesOnChain(fx.chainId, wallet, fx.fiatTokens);
    const entry: BalanceCacheEntry = {
      chainId: fx.chainId,
      byCurrency,
      fetchedAt: Date.now(),
    };
    balanceCache.set(key, entry);
    return entry;
  })();

  balanceInflight.set(key, job);
  try {
    return await job;
  } finally {
    balanceInflight.delete(key);
  }
}

/** Fire-and-forget warm-up (Cash tab mount). */
export function warmSpendableMantleBalances(
  getAccessToken: () => Promise<string | null>,
  wallet: string | undefined | null,
): void {
  if (!wallet) return;
  void fetchSpendableMantleBalances(getAccessToken, wallet).catch(() => {
    // Best-effort — sheets still fetch on open.
  });
}
