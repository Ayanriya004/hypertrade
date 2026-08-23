/**
 * Deribit public DVOL (implied-volatility index) — free, no API key.
 *
 * Fetched once and shared across all agents + worker restarts via the global
 * context cache (Supabase). TTL is kept short (below the brain's 30-min
 * `optFresh` guard) so the newest bar stays "fresh" and IV signals actually
 * fire — DVOL barely moves intraday but freshness gates the signal. Slower
 * global contexts (macro calendar etc.) will use much longer TTLs on the same
 * cache; DVOL just needs to stay live.
 *
 * NOTE: Deribit sits behind Cloudflare and rejects datacenter requests that
 * lack a browser-like User-Agent (returns HTML/403), which silently produced
 * empty options series in the worker. The explicit UA header fixes that.
 *
 * DVOL indices exist only for BTC and ETH (verified 2026-07: SOL/XRP return
 * empty). Callers should use `supportsDeribitDvol` to skip the round-trip for
 * other HL coins — `getDvolOptionsBars` also no-ops as a safety net.
 */
import type { OptionsBar } from '../brain/computeScalperFlags.js';
import { getOrRefreshGlobalContext } from '../lib/globalCache.js';

/** Coins with a live Deribit DVOL series. Do not add SOL/XRP until Deribit ships one. */
const DVOL_CURRENCIES = new Set(['BTC', 'ETH']);

export function supportsDeribitDvol(hlCoin: string): boolean {
  return DVOL_CURRENCIES.has(hlCoin.toUpperCase());
}

// Below the 30-min optFresh guard so each hourly cycle refetches and the latest
// bar is always recent. Still a single shared fetch per cycle for all agents.
const DVOL_TTL_MS = 25 * 60 * 1000;

interface DvolResponse {
  result?: { data?: [number, number, number, number, number][] };
}

const DVOL_RESOLUTION_MS = 60 * 60 * 1000; // 1h bars (resolution=3600)

async function fetchDvol(currency: string): Promise<OptionsBar[]> {
  const end = Date.now();
  const start = end - 24 * 60 * 60 * 1000;
  const url =
    `https://www.deribit.com/api/v2/public/get_volatility_index_data` +
    `?currency=${currency}&start_timestamp=${start}&end_timestamp=${end}&resolution=3600`;
  const res = await fetch(url, {
    headers: {
      accept: 'application/json',
      // Datacenter IPs are blocked without a browser-like UA (Cloudflare).
      'user-agent':
        'Mozilla/5.0 (compatible; HyperTradeAI/1.0; +https://hypertrade.exchange)',
    },
  });
  if (!res.ok) throw new Error(`Deribit DVOL HTTP ${res.status}`);
  const body = (await res.json()) as DvolResponse;
  // Deribit keys bars by OPEN time. The brain's freshness guard compares the
  // latest bar's timestamp to `now`, and our cycle runs on the hour — so the
  // last completed hourly bar's open-time is ~60min old and would (wrongly)
  // read as stale, nulling IV. Stamp bars with their CLOSE time (open +
  // interval), which is the correct "as-of" instant for the close value.
  return (body.result?.data ?? []).map(([ts, open, , , close]) => ({
    timestamp: ts + DVOL_RESOLUTION_MS,
    dvol_open: open,
    dvol_close: close,
  }));
}

export async function getDvolOptionsBars(hlCoin: string): Promise<OptionsBar[]> {
  const currency = hlCoin.toUpperCase();
  if (!supportsDeribitDvol(currency)) return [];
  const bars = await getOrRefreshGlobalContext<OptionsBar[]>({
    key: `deribit_dvol_${currency}`,
    ttlMs: DVOL_TTL_MS,
    produce: () => fetchDvol(currency),
  });
  return bars ?? [];
}
