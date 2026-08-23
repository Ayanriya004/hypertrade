/**
 * CoinGlass v4 → brain MarketData adapter.
 *
 * Standard plan (2026-07): intervals down to 1m, 300 req/min. We use 1h bars
 * — matches the hourly cycle (every cycle sees a freshly closed bar; no more
 * 4h-boundary "no new bar" idling) without plugging 1m noise into the brain.
 * PACE_MS 250 ≈ 240 req/min, ~80% of the plan limit.
 * (Hobbyist fallback: intervals ≥ 4h, 30 req/min — if reverting, restore
 * INTERVAL '4h' / BARS 72 and the old freshness guards in computeScalperFlags.)
 *
 * Strategy:
 *   • Prefer coin-level aggregated series where Hobbyist allows (OI, funding
 *     OI-weight, futures/spot taker, liquidations).
 *   • Futures aggregates exclude Coinbase (weak perp signal). Spot aggregates
 *     include Coinbase (strong spot action / premium reference).
 *   • Price OHLC has no aggregated endpoint — try venues until one works.
 *   • Spot + every non-price series are best-effort. Missing spot / OI /
 *     funding / flow / even futures price returns null (soft skip) — never
 *     hard-fail the cycle for one thin symbol.
 *
 * Per-symbol budget: ~7 GETs + short venue fallbacks, paced ~4/sec.
 */
import type { ComputeInput, FuturesBar, OptionsBar, SpotBar } from '../brain/computeScalperFlags.js';
import type { EtfFlowsContext } from './etfFlows.js';

const BASE = 'https://open-api-v4.coinglass.com';
/**
 * Per-fetch bar interval. Default 1h (cycle-matched). Crypto SCALPERS fetch
 * 30m for a fresher last bar + finer flags at the same hourly cadence — their
 * flag windows are scaled ×2 at compute time so wall-clock lookbacks (and the
 * thresholds tuned on them) are preserved. HIP-3 stays 1h (thin venue book;
 * options/daily closes lead there, sub-hour venue bars are noise).
 */
export type BarInterval = '1h' | '30m';
const DEFAULT_INTERVAL: BarInterval = '1h';
/** Cycle-boundary interval (hourly cycles) — NOT the per-fetch bar size. */
export const INTERVAL_MS = 60 * 60 * 1000;
export function barIntervalMsOf(interval: BarInterval): number {
  return interval === '30m' ? 30 * 60 * 1000 : 60 * 60 * 1000;
}
/** ~5 days of bars — covers the flags' (scaled) 60-bar hist window with buffer. */
const BARS_BY_INTERVAL: Record<BarInterval, number> = { '1h': 120, '30m': 240 };
const PACE_MS = 250;

/** Perp aggregates — Coinbase omitted (noisy / thin for perp microstructure). */
const FUT_AGG_EXCHANGE_LIST = 'Binance,OKX,Bybit,Hyperliquid';
/**
 * HIP-3 perp aggregates — CoinGlass files HL builder dexes as their OWN
 * exchange ("tradeXYZ", instrument "TSLA-USD"), NOT under "Hyperliquid", so
 * the standard list silently misses the venue we actually trade on (which is
 * also the highest-volume TSLA perp). CEXes stay for the few tokenized
 * stocks they carry.
 */
const HIP3_FUT_AGG_EXCHANGE_LIST = 'tradeXYZ,Binance,OKX,Bybit';
/** Spot aggregates — Coinbase included for spot-flow + premium reference. */
const SPOT_AGG_EXCHANGE_LIST = 'Binance,Coinbase,OKX,Bybit,Hyperliquid';

type Venue = { exchange: string; symbol: string };

/** HL coin → primary Binance-style pair (kept for call-site compat). */
export function toCoinglassPair(hlCoin: string): string {
  return `${hlCoin.toUpperCase()}USDT`;
}

function futuresVenueCandidates(coin: string, hip3 = false): Venue[] {
  const c = coin.toUpperCase();
  if (hip3) {
    // tradeXYZ first: covers ALL HIP-3 symbols (stocks/commodities/forex/
    // indices) and is the book we trade — its price/funding/OI is the signal
    // that matters. Binance/OKX only list a handful of tokenized stocks.
    return [
      { exchange: 'tradeXYZ', symbol: `${c}-USD` },
      { exchange: 'Binance', symbol: `${c}USDT` },
      { exchange: 'OKX', symbol: `${c}USDT` },
      { exchange: 'Bybit', symbol: `${c}USDT` },
    ];
  }
  // No Coinbase — weak for perps signals.
  return [
    { exchange: 'Binance', symbol: `${c}USDT` },
    { exchange: 'Hyperliquid', symbol: `${c}USDC` },
    { exchange: 'OKX', symbol: `${c}USDT` },
    { exchange: 'Bybit', symbol: `${c}USDT` },
  ];
}

function spotVenueCandidates(coin: string): Venue[] {
  const c = coin.toUpperCase();
  // Coinbase first when available — strong spot action / classic basis ref.
  return [
    { exchange: 'Coinbase', symbol: `${c}-USD` },
    { exchange: 'Coinbase', symbol: `${c}USD` },
    { exchange: 'Binance', symbol: `${c}USDT` },
    { exchange: 'Hyperliquid', symbol: `${c}USDC` },
    { exchange: 'OKX', symbol: `${c}USDT` },
    { exchange: 'Bybit', symbol: `${c}USDT` },
  ];
}

type RawRow = Record<string, string | number>;

function num(v: string | number | undefined | null): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

async function cgGet(path: string, apiKey: string, params: Record<string, string>): Promise<RawRow[]> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}${path}?${qs}`, {
    headers: { 'CG-API-KEY': apiKey, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`CoinGlass ${path} HTTP ${res.status}`);
  const body = (await res.json()) as { code?: string; msg?: string; data?: RawRow[] };
  if (body.code !== '0') {
    throw new Error(`CoinGlass ${path} error: ${body.msg ?? body.code}`);
  }
  return body.data ?? [];
}

/** Soft GET — empty on any failure (optional series). */
async function cgGetOptional(
  path: string,
  apiKey: string,
  params: Record<string, string>,
): Promise<RawRow[]> {
  try {
    return await cgGet(path, apiKey, params);
  } catch (err) {
    console.warn(
      `[coinglass] optional ${path} skipped:`,
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

async function cgGetFirstVenue(
  path: string,
  apiKey: string,
  venues: Venue[],
  base: Record<string, string>,
): Promise<{ rows: RawRow[]; venue: Venue | null }> {
  for (const venue of venues) {
    try {
      const rows = await cgGet(path, apiKey, {
        ...base,
        exchange: venue.exchange,
        symbol: venue.symbol,
      });
      if (rows.length > 0) return { rows, venue };
    } catch (err) {
      console.warn(
        `[coinglass] ${path} ${venue.exchange}/${venue.symbol}:`,
        err instanceof Error ? err.message : err,
      );
    }
    await sleep(PACE_MS);
  }
  return { rows: [], venue: null };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Coins confirmed to have no spot listing (per-process; re-checked daily). */
const spotMissingMemo = new Map<string, number>();
const SPOT_MISS_RECHECK_MS = 24 * 60 * 60 * 1000;

/**
 * Last venue that served a coin's price series (per-process). Tried FIRST on
 * later cycles: e.g. LIT's spot lists on Bybit ONLY — the last candidate —
 * so without this memo every cycle walked 5 failing venues (5 wasted GETs +
 * 5 error lines) before hitting it. Falls back to the full chain when the
 * memoized venue stops serving.
 */
const futVenueMemo = new Map<string, Venue>();
const spotVenueMemo = new Map<string, Venue>();

/**
 * Memo persistence (marketCache round-trips these through
 * global_context_cache): redeploys otherwise reset the in-process maps and
 * replay the full probe/error burst for every known-missing pair.
 */
export interface CoinglassMemoSnapshot {
  spotMissing: Record<string, number>;
  futVenues: Record<string, Venue>;
  spotVenues: Record<string, Venue>;
}

export function exportCoinglassMemos(): CoinglassMemoSnapshot {
  return {
    spotMissing: Object.fromEntries(spotMissingMemo),
    futVenues: Object.fromEntries(futVenueMemo),
    spotVenues: Object.fromEntries(spotVenueMemo),
  };
}

export function hydrateCoinglassMemos(snap: Partial<CoinglassMemoSnapshot> | null | undefined): void {
  if (!snap) return;
  for (const [coin, at] of Object.entries(snap.spotMissing ?? {})) {
    if (Number.isFinite(at) && !spotMissingMemo.has(coin)) spotMissingMemo.set(coin, at);
  }
  for (const [coin, v] of Object.entries(snap.futVenues ?? {})) {
    if (v?.exchange && v?.symbol && !futVenueMemo.has(coin)) futVenueMemo.set(coin, v);
  }
  for (const [coin, v] of Object.entries(snap.spotVenues ?? {})) {
    if (v?.exchange && v?.symbol && !spotVenueMemo.has(coin)) spotVenueMemo.set(coin, v);
  }
}

function memoFirst(memo: Map<string, Venue>, coin: string, candidates: Venue[]): Venue[] {
  const m = memo.get(coin);
  if (!m) return candidates;
  return [m, ...candidates.filter((c) => c.exchange !== m.exchange || c.symbol !== m.symbol)];
}

/**
 * Cheap entitlement probe — one lightweight GET.
 * Used so Phase-1 can fetch full series once per symbol (house or first valid
 * user key) while still requiring each agent to hold a working key.
 */
export async function probeCoinglassKey(apiKey: string): Promise<boolean> {
  if (!apiKey.trim()) return false;
  try {
    await cgGet('/api/futures/price/history', apiKey, {
      exchange: 'Binance',
      symbol: 'BTCUSDT',
      interval: DEFAULT_INTERVAL,
      limit: '1',
    });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[coinglass] key probe failed: ${msg}`);
    return false;
  }
}

/** Same cadence as Phase-1 per-symbol fetch retries (marketCache). */
export const COINGLASS_PROBE_RETRY_DELAY_MS = 10_000;
export const COINGLASS_PROBE_MAX_ATTEMPTS = 2;

/**
 * House-key probe with one retry. A single CoinGlass 429/5xx at the cycle
 * boundary used to skip every ticker for the hour (`0 series`).
 */
export async function probeCoinglassKeyWithRetry(
  apiKey: string,
  label = 'house CoinGlass key',
): Promise<boolean> {
  for (let attempt = 1; attempt <= COINGLASS_PROBE_MAX_ATTEMPTS; attempt += 1) {
    const ok = await probeCoinglassKey(apiKey);
    if (ok) {
      if (attempt > 1) {
        console.warn(`[phase1] ${label} probe recovered on attempt ${attempt}/${COINGLASS_PROBE_MAX_ATTEMPTS}`);
      }
      return true;
    }
    if (attempt < COINGLASS_PROBE_MAX_ATTEMPTS) {
      console.warn(
        `[phase1] ${label} probe failed — retry ${attempt + 1}/${COINGLASS_PROBE_MAX_ATTEMPTS} in ${COINGLASS_PROBE_RETRY_DELAY_MS / 1000}s`,
      );
      await new Promise((r) => setTimeout(r, COINGLASS_PROBE_RETRY_DELAY_MS));
    }
  }
  return false;
}

export interface CoinglassMarketData extends ComputeInput {
  symbol: string;
  fetchedAt: string;
  /** Bar size of the fetched series (ms). Consumers scale windows off this. */
  barIntervalMs: number;
  /** Daily spot-ETF flow context — BTC/ETH/SOL/XRP only, else null/absent. */
  etfFlows?: EtfFlowsContext | null;
  /** Options positioning (ΔOI, vol/OI, premium PCR) — BTC/ETH only. */
  optionsPositioning?: import('./optionsPositioning.js').OptionsPositioningContext | null;
  /** Live EMA stack (CoinGlass ema/list) — HIP-3 preferred. */
  ema?: import('./emaList.js').EmaContext | null;
  /** Next earnings (Supabase earnings_cache) — equity HIP-3 only. */
  earnings?: import('./earnings.js').EarningsContext | null;
  /** Listed US options chain metrics (Massive.com) — equity HIP-3 only. */
  equityOptions?: import('./equityOptions.js').EquityOptionsContext | null;
  /** Real US daily-bar trend context (Massive aggs) — equity/metals HIP-3. */
  equityDaily?: import('./equityDaily.js').EquityDailyContext | null;
  /** Crypto-only stretch / exhaustion features (RSI + EMA + wall-clock pctls). */
  cryptoExtension?: import('./cryptoExtension.js').CryptoExtensionContext | null;
}

/**
 * Fetch all series for one HL coin and merge into the brain's ComputeInput
 * shape. `optionsBars` (Deribit DVOL, house-cached) is merged in by the caller.
 */
/**
 * Returns null when futures OHLC is unavailable on every venue (soft skip).
 * Never throws for missing optional series (spot / OI / funding / flow / liq).
 */
export async function fetchMarketData(args: {
  hlCoin: string;
  apiKey: string;
  optionsBars?: OptionsBar[];
  interval?: BarInterval;
}): Promise<CoinglassMarketData | null> {
  const coin = args.hlCoin.toUpperCase();
  // HIP-3 (e.g. XYZ:TSLA): CoinGlass tracks the underlying as a plain coin
  // ("TSLA" appears in /futures/supported-coins) — the HL builder dex shows
  // up as its own exchange "tradeXYZ" (instrument "TSLA-USD") and is tried
  // FIRST; Binance/OKX tokenized-stock perps are fallbacks. No HL-native
  // candle fallback — if CoinGlass has nothing, the symbol soft-skips.
  const hip3 = coin.includes(':');
  const coinPart = hip3 ? coin.slice(coin.indexOf(':') + 1) : coin;
  const key = args.apiKey;
  const INTERVAL = args.interval ?? DEFAULT_INTERVAL;
  const limit = String(BARS_BY_INTERVAL[INTERVAL]);
  const coinCommon = { symbol: coinPart, interval: INTERVAL, limit };
  const futAggList = hip3 ? HIP3_FUT_AGG_EXCHANGE_LIST : FUT_AGG_EXCHANGE_LIST;
  const futAggCommon = {
    ...coinCommon,
    exchange_list: futAggList,
    unit: 'usd',
  };
  const spotAggCommon = {
    ...coinCommon,
    exchange_list: SPOT_AGG_EXCHANGE_LIST,
    unit: 'usd',
  };
  const pairBase = { interval: INTERVAL, limit };

  // 1) Futures price — preferred for trading; soft-null if all venues miss.
  // Last-successful venue first: coins living on later candidates otherwise
  // burn failing GETs + error logs on every cycle.
  const futPriceHit = await cgGetFirstVenue(
    '/api/futures/price/history',
    key,
    memoFirst(futVenueMemo, coin, futuresVenueCandidates(coinPart, hip3)),
    pairBase,
  );
  if (futPriceHit.rows.length === 0 || !futPriceHit.venue) {
    console.warn(`[coinglass] ${coin}: no futures price on any venue — soft skip`);
    return null;
  }
  futVenueMemo.set(coin, futPriceHit.venue);
  const priceVenue = futPriceHit.venue;
  const pairParams = {
    exchange: priceVenue.exchange,
    symbol: priceVenue.symbol,
    interval: INTERVAL,
    limit,
  };
  console.log(
    `[coinglass] ${coin} futures price via ${priceVenue.exchange}/${priceVenue.symbol}`,
  );

  // 2) Futures taker — aggregated coin-level, else pair on price venue.
  await sleep(PACE_MS);
  let futTaker = await cgGetOptional(
    '/api/futures/aggregated-taker-buy-sell-volume/history',
    key,
    futAggCommon,
  );
  if (futTaker.length === 0) {
    await sleep(PACE_MS);
    futTaker = await cgGetOptional('/api/futures/v2/taker-buy-sell-volume/history', key, pairParams);
  }

  // 3) OI — aggregated coin-level, else pair.
  await sleep(PACE_MS);
  let futOi = await cgGetOptional('/api/futures/open-interest/aggregated-history', key, {
    ...coinCommon,
    unit: 'usd',
  });
  if (futOi.length === 0) {
    await sleep(PACE_MS);
    futOi = await cgGetOptional('/api/futures/open-interest/history', key, pairParams);
  }

  // 4) Funding — OI-weighted cross-exchange, else pair.
  await sleep(PACE_MS);
  let futFunding = await cgGetOptional(
    '/api/futures/funding-rate/oi-weight-history',
    key,
    coinCommon,
  );
  if (futFunding.length === 0) {
    await sleep(PACE_MS);
    futFunding = await cgGetOptional('/api/futures/funding-rate/history', key, pairParams);
  }

  // 5) Liquidations — aggregated coin-level, else pair.
  await sleep(PACE_MS);
  let futLiq = await cgGetOptional('/api/futures/liquidation/aggregated-history', key, {
    symbol: coinPart,
    interval: INTERVAL,
    limit,
    exchange_list: futAggList,
  });
  if (futLiq.length === 0) {
    await sleep(PACE_MS);
    futLiq = await cgGetOptional('/api/futures/liquidation/history', key, pairParams);
  }

  // 6–7) Spot — entirely optional (Coinbase-first price for premium; agg taker).
  // Futures-only coins (e.g. LIT) have NO spot listing anywhere: without the
  // memo the venue chain burned ~5 GETs + 5 error log lines EVERY cycle.
  // Remember the miss per process and re-check daily (new listings do happen).
  // Spot: even tokenized stocks may have spot listings somewhere — let the
  // venue chain discover it once; the miss-memo silences known-absent ones.
  const spotMissAt = spotMissingMemo.get(coin);
  const skipSpot = spotMissAt != null && Date.now() - spotMissAt < SPOT_MISS_RECHECK_MS;
  let spotPriceHit: { rows: RawRow[]; venue: Venue | null } = { rows: [], venue: null };
  let spotTaker: RawRow[] = [];
  if (!skipSpot) {
    await sleep(PACE_MS);
    spotPriceHit = await cgGetFirstVenue(
      '/api/spot/price/history',
      key,
      memoFirst(spotVenueMemo, coin, spotVenueCandidates(coinPart)),
      pairBase,
    );
    if (spotPriceHit.venue) {
      spotMissingMemo.delete(coin);
      spotVenueMemo.set(coin, spotPriceHit.venue);
      console.log(
        `[coinglass] ${coin} spot price via ${spotPriceHit.venue.exchange}/${spotPriceHit.venue.symbol}`,
      );
    } else {
      spotMissingMemo.set(coin, Date.now());
      console.log(`[coinglass] ${coin}: no spot listing on any venue — skipping spot for 24h`);
    }
    await sleep(PACE_MS);
    spotTaker = await cgGetOptional(
      '/api/spot/aggregated-taker-buy-sell-volume/history',
      key,
      spotAggCommon,
    );
    if (spotTaker.length === 0 && spotPriceHit.venue) {
      await sleep(PACE_MS);
      spotTaker = await cgGetOptional('/api/spot/taker-buy-sell-volume/history', key, {
        exchange: spotPriceHit.venue.exchange,
        symbol: spotPriceHit.venue.symbol,
        interval: INTERVAL,
        limit,
      });
    }
  }

  // Merge futures series by bar timestamp.
  const futBars = new Map<number, FuturesBar>();
  const bar = (t: number): FuturesBar => {
    let b = futBars.get(t);
    if (!b) {
      b = { timestamp: t };
      futBars.set(t, b);
    }
    return b;
  };

  for (const r of futPriceHit.rows) {
    const t = num(r.time);
    if (t == null) continue;
    const b = bar(t);
    b.open_price = num(r.open);
    b.high_price = num(r.high);
    b.low_price = num(r.low);
    b.close_price = num(r.close);
    b.dollar_volume = num(r.volume_usd);
  }
  for (const r of futTaker) {
    const t = num(r.time);
    if (t == null) continue;
    const b = bar(t);
    b.buy_dollar_volume = num(r.aggregated_buy_volume_usd ?? r.taker_buy_volume_usd);
    b.sell_dollar_volume = num(r.aggregated_sell_volume_usd ?? r.taker_sell_volume_usd);
  }
  for (const r of futOi) {
    const t = num(r.time);
    if (t == null) continue;
    const b = bar(t);
    b.dollar_open_interest_close = num(r.close);
    b.dollar_open_interest_high = num(r.high);
    b.dollar_open_interest_low = num(r.low);
  }
  for (const r of futFunding) {
    const t = num(r.time);
    if (t == null) continue;
    bar(t).funding_rate = num(r.close);
  }
  for (const r of futLiq) {
    const t = num(r.time);
    if (t == null) continue;
    const b = bar(t);
    // Velo semantics: buy-liquidations are forced BUYS (shorts liquidated).
    const shortLiq = num(r.aggregated_short_liquidation_usd ?? r.short_liquidation_usd);
    const longLiq = num(r.aggregated_long_liquidation_usd ?? r.long_liquidation_usd);
    b.buy_liquidations_dollar_volume = shortLiq;
    b.sell_liquidations_dollar_volume = longLiq;
    b.liquidations_dollar_volume = (shortLiq ?? 0) + (longLiq ?? 0);
  }

  // Spot bars (taker flow + close price for the premium calc).
  const spotBars = new Map<number, SpotBar & { close_price?: number }>();
  const sBar = (t: number) => {
    let b = spotBars.get(t);
    if (!b) {
      b = { timestamp: t };
      spotBars.set(t, b);
    }
    return b;
  };
  for (const r of spotPriceHit.rows) {
    const t = num(r.time);
    if (t == null) continue;
    const b = sBar(t);
    b.close_price = num(r.close);
    b.dollar_volume = num(r.volume_usd);
  }
  for (const r of spotTaker) {
    const t = num(r.time);
    if (t == null) continue;
    const b = sBar(t);
    b.buy_dollar_volume = num(r.aggregated_buy_volume_usd ?? r.taker_buy_volume_usd);
    b.sell_dollar_volume = num(r.aggregated_sell_volume_usd ?? r.taker_sell_volume_usd);
  }

  // Premium (perp vs spot basis, in bps) — only when spot close exists.
  for (const [t, fb] of futBars) {
    const sp = spotBars.get(t)?.close_price;
    if (fb.close_price != null && sp != null && sp > 0) {
      fb.premium = ((fb.close_price - sp) / sp) * 10_000;
    }
  }

  const sortByTs = <T extends { timestamp: number }>(m: Map<number, T>): T[] =>
    [...m.values()].sort((a, b) => a.timestamp - b.timestamp);

  const futuresSeries = sortByTs(futBars);
  if (futuresSeries.length === 0) {
    console.warn(`[coinglass] ${coin}: futures bars empty after merge — soft skip`);
    return null;
  }

  return {
    symbol: coin,
    fetchedAt: new Date().toISOString(),
    barIntervalMs: barIntervalMsOf(INTERVAL),
    futures: { timeSeries: futuresSeries },
    spot: { timeSeries: sortByTs(spotBars) },
    options: { timeSeries: args.optionsBars ?? [] },
  };
}
