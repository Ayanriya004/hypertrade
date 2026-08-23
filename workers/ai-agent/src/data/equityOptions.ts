/**
 * Listed-options context for HIP-3 — Massive (ex-Polygon.io) chain snapshot.
 *
 *   • Equities: underlier ticker = coin part (TSLA, …)
 *   • Metals: GOLD→GLD, SILVER→SLV ETF proxies (COMEX options aren't on
 *     Massive; GLD/SLV are where US-listed metals positioning shows)
 *
 * What we compute (near-ATM ±12%, expiries ≤21d — the tradeable window):
 *   • ATM IV (median of ±5% strikes) + Δ vs our previous snapshot
 *   • Skew (OTM put IV − OTM call IV, 3–10% wings) — risk-reversal read,
 *     hardened: skip ≤2d front when back-month wings exist; drop IVs >2.5× ATM
 *   • Put/Call DAY-VOLUME / premium / OI ratios + day-vol/OI turnover
 *
 * Data is 15-min delayed on the current plan — fine for hourly cycles.
 * Globally cached 30 min; missing tickers memoized 24h.
 */
import { config } from '../config.js';
import { assetClassOf, coinPart, isHip3Symbol } from '../brain/assetClass.js';
import { getOrRefreshGlobalContext, readGlobalContext } from '../lib/globalCache.js';

export interface EquityOptionsContext {
  /** Massive options underlier (e.g. TSLA, or GLD/SLV for metals). */
  symbol: string;
  /** HIP-3 coin when options are a proxy (GOLD/SILVER); null/absent for equities. */
  proxyFor?: string | null;
  /** Median IV of ±5% strikes across near expiries, in percent (e.g. 62.4). */
  atmIvPct: number | null;
  /** Δ ATM IV in points vs our previous snapshot (≈ last cycle). */
  atmIvChangePts: number | null;
  /** ATM IV of the NEAREST expiry only — cleaner event read (no term mixing). */
  nearestAtmIvPct: number | null;
  /**
   * Skew: median IV of OTM puts (3–10% below spot) − OTM calls (3–10% above),
   * in IV points. Positive = downside protection bid over upside.
   */
  skewPts: number | null;
  /** Put/Call ratio of today's contract volume across the window. */
  pcVolumeRatio: number | null;
  /** Put/Call ratio of dollar premium traded today (vol × vwap × shares). */
  pcPremiumRatio: number | null;
  /** Put/Call ratio of open interest (standing book). */
  pcOiRatio: number | null;
  /** Today's total volume / total OI — turnover of the near book. */
  volOiRatio: number | null;
  /** Nearest expiry in the window (YYYY-MM-DD) + days until it. */
  nearestExpiry: string | null;
  nearestExpiryDays: number | null;
  contractsSampled: number;
  updatedAt: string;
}

const TTL_MS = 30 * 60 * 1000;
const BASE = 'https://api.massive.com';
const EXPIRY_WINDOW_DAYS = 21;
const STRIKE_WINDOW_PCT = 0.12; // ±12% around spot
const ATM_BAND_PCT = 0.05; // ±5% for the ATM IV median

/** HIP-3 commodity coin → US-listed ETF options underlier. */
const METALS_OPTIONS_PROXY: Record<string, string> = {
  GOLD: 'GLD',
  SILVER: 'SLV',
};

const missingTickerMemo = new Map<string, number>();
const MISSING_RECHECK_MS = 24 * 60 * 60 * 1000;

interface ChainContract {
  day?: { volume?: number; vwap?: number };
  details?: {
    contract_type?: string;
    strike_price?: number;
    expiration_date?: string;
    shares_per_contract?: number;
  };
  implied_volatility?: number;
  open_interest?: number;
  underlying_asset?: { price?: number };
}

export function metalsOptionsProxy(hlCoin: string): string | null {
  if (!isHip3Symbol(hlCoin) || assetClassOf(hlCoin) !== 'commodity') return null;
  return METALS_OPTIONS_PROXY[coinPart(hlCoin)] ?? null;
}

/** Massive options ticker for this HIP-3 symbol (underlier or ETF proxy). */
export function resolveOptionsTicker(hlCoin: string): string | null {
  if (!isHip3Symbol(hlCoin) || config.massiveApiKey == null) return null;
  const coin = coinPart(hlCoin);
  const cls = assetClassOf(hlCoin);
  if (cls === 'equity') return coin;
  if (cls === 'commodity') return METALS_OPTIONS_PROXY[coin] ?? null;
  return null;
}

export function isMetalsOptionsAsset(hlCoin: string): boolean {
  return metalsOptionsProxy(hlCoin) != null;
}

/** Equity underlier OR GOLD/SILVER via GLD/SLV — needs MASSIVE_API_KEY. */
export function supportsEquityOptions(hlCoin: string): boolean {
  return resolveOptionsTicker(hlCoin) != null;
}

async function fetchProxySpot(ticker: string, apiKey: string): Promise<number | null> {
  // Prev daily bar close — enough to center the strike window for ETF proxies
  // (never use HL GOLD/SILVER $ levels; those are ~10× ETF prices).
  try {
    const res = await fetch(`${BASE}/v2/aggs/ticker/${ticker}/prev`, {
      headers: { Authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { results?: Array<{ c?: number }> };
    const c = Number(body.results?.[0]?.c);
    return Number.isFinite(c) && c > 0 ? c : null;
  } catch {
    return null;
  }
}

/** Max pagination pages (250/page). Dense weekly chains (TSLA) overflow one page
 * and `sort: expiration_date asc` would silently drop the later expiries from
 * every P/C total — follow next_url a few hops instead. */
const MAX_CHAIN_PAGES = 4;

async function fetchChain(
  ticker: string,
  apiKey: string,
  spotHint: number | null,
): Promise<ChainContract[]> {
  const today = new Date();
  const lte = new Date(today.getTime() + EXPIRY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const params = new URLSearchParams({
    'expiration_date.gte': today.toISOString().slice(0, 10),
    'expiration_date.lte': lte.toISOString().slice(0, 10),
    limit: '250',
    sort: 'expiration_date',
    order: 'asc',
  });
  if (spotHint != null && Number.isFinite(spotHint) && spotHint > 0) {
    params.set('strike_price.gte', String(Math.floor(spotHint * (1 - STRIKE_WINDOW_PCT))));
    params.set('strike_price.lte', String(Math.ceil(spotHint * (1 + STRIKE_WINDOW_PCT))));
  }

  const out: ChainContract[] = [];
  let url: string | null = `${BASE}/v3/snapshot/options/${ticker}?${params.toString()}`;
  for (let page = 0; url && page < MAX_CHAIN_PAGES; page += 1) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    });
    if (!res.ok) {
      if (page === 0) throw new Error(`Massive chain ${ticker} HTTP ${res.status}`);
      break; // partial book is still usable
    }
    const body = (await res.json()) as { results?: ChainContract[]; next_url?: string };
    out.push(...(body.results ?? []));
    url = body.next_url ? `${body.next_url}` : null;
  }
  return out;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Nearest-expiry ATM IV with vendor-blowup defense.
 * Massive returns IV as a decimal (1.60 = 160%); we store percent.
 * When call/put ATM medians diverge hard (typical 0DTE earnings American
 * solver artifact), prefer the lower side — pooling them yields fantasy
 * numbers like INTC 458% next to a sane ~160% blended ATM.
 * Also drop nearest when it still looks absurd vs the multi-expiry ATM,
 * or when absolute IV > 250% (earnings-elevated ATM still leaked ~300%).
 */
function robustNearestAtmIv(
  callMed: number | null,
  putMed: number | null,
  blendedAtm: number | null,
): number | null {
  let nearest: number | null = null;
  if (callMed != null && putMed != null) {
    const hi = Math.max(callMed, putMed);
    const lo = Math.min(callMed, putMed);
    nearest = hi > lo * 1.75 ? lo : (callMed + putMed) / 2;
  } else {
    nearest = callMed ?? putMed;
  }
  if (nearest == null) return null;
  if (blendedAtm != null && blendedAtm > 0 && nearest > blendedAtm * 2.5) {
    return null;
  }
  // Absolute ceiling: when blended ATM is itself earnings-elevated (~130%),
  // the 2.5× relative gate still lets through ~300% nearest (INTC overnight).
  // Above 250% annualized is not a useful event read for the agent.
  if (nearest > 250) return null;
  return nearest;
}

interface WingIv {
  ivPct: number;
  expiry: string | null;
}

/**
 * Risk-reversal skew from OTM wings, hardened against 0DTE/earnings solver
 * blowups (INTC: +111 pts from front-month put IVs ~375% vs call wings).
 *   1. Prefer wings with >2d to expiry when the front is ≤2d (event IV ≠ RR)
 *   2. Drop wing IVs >2.5× blended ATM (same artifact family as nearest ATM)
 *   3. Null skew if sides still diverge >1.75× (not a real RR signal)
 */
function robustSkewPts(
  putWings: WingIv[],
  callWings: WingIv[],
  atmIvPct: number | null,
  nearestExpiryDays: number | null,
  now: Date,
): number | null {
  const atmCap =
    atmIvPct != null && atmIvPct > 0 ? atmIvPct * 2.5 : null;
  const preferBack =
    nearestExpiryDays != null && nearestExpiryDays <= 2;

  const filterSide = (wings: WingIv[]): number[] => {
    let xs = wings;
    if (preferBack) {
      const back = wings.filter(
        (w) => w.expiry != null && daysUntilUtc(w.expiry, now) > 2,
      );
      if (back.length >= 2) xs = back;
    }
    return xs
      .map((w) => w.ivPct)
      .filter((iv) => atmCap == null || iv <= atmCap);
  };

  const putWing = median(filterSide(putWings));
  const callWing = median(filterSide(callWings));
  if (putWing == null || callWing == null) return null;

  const hi = Math.max(putWing, callWing);
  const lo = Math.min(putWing, callWing);
  // Same-family artifact: one wing solver-blown vs the other.
  if (lo > 0 && hi > lo * 1.75) return null;

  return putWing - callWing;
}

function daysUntilUtc(ymd: string, now: Date): number {
  const target = Date.parse(`${ymd}T00:00:00Z`);
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.round((target - today) / (24 * 60 * 60 * 1000));
}

async function produce(
  ticker: string,
  apiKey: string,
  spotHint: number | null,
  cacheKey: string,
  proxyFor: string | null,
): Promise<EquityOptionsContext> {
  const prev = await readGlobalContext<EquityOptionsContext>(cacheKey).catch(() => null);

  const contracts = await fetchChain(ticker, apiKey, spotHint);
  const now = new Date();
  const empty: EquityOptionsContext = {
    symbol: ticker,
    proxyFor,
    atmIvPct: null,
    atmIvChangePts: null,
    nearestAtmIvPct: null,
    skewPts: null,
    pcVolumeRatio: null,
    pcPremiumRatio: null,
    pcOiRatio: null,
    volOiRatio: null,
    nearestExpiry: null,
    nearestExpiryDays: null,
    contractsSampled: 0,
    updatedAt: now.toISOString(),
  };
  if (contracts.length === 0) {
    missingTickerMemo.set(ticker, Date.now());
    return empty;
  }
  missingTickerMemo.delete(ticker);

  const spot =
    contracts.find((c) => Number.isFinite(c.underlying_asset?.price as number))
      ?.underlying_asset?.price ?? spotHint ?? null;

  let callVol = 0;
  let putVol = 0;
  let callPrem = 0;
  let putPrem = 0;
  let callOi = 0;
  let putOi = 0;
  const atmIvs: number[] = [];
  const otmPutWings: WingIv[] = []; // strikes 3–10% BELOW spot
  const otmCallWings: WingIv[] = []; // strikes 3–10% ABOVE spot
  let nearestExpiry: string | null = null;
  for (const c of contracts) {
    const expiry = c.details?.expiration_date;
    if (expiry && (!nearestExpiry || expiry < nearestExpiry)) nearestExpiry = expiry;
  }
  // Nearest-expiry ATM kept by side — Massive's American IV solver often
  // blows up one side into 0DTE earnings (INTC Jul-24: ATM calls ~160%,
  // same-strike puts ~375%). A pooled median then prints ~450% nonsense.
  const nearestAtmCallIvs: number[] = [];
  const nearestAtmPutIvs: number[] = [];

  for (const c of contracts) {
    const type = c.details?.contract_type;
    if (type !== 'call' && type !== 'put') continue;
    const strike = Number(c.details?.strike_price);
    const vol = Number(c.day?.volume) || 0;
    const vwap = Number(c.day?.vwap) || 0;
    const shares = Number(c.details?.shares_per_contract) || 100;
    const oi = Number(c.open_interest) || 0;
    const iv = Number(c.implied_volatility);
    const expiry = c.details?.expiration_date ?? null;

    const premium = vol * vwap * shares;
    if (type === 'call') {
      callVol += vol;
      callPrem += premium;
      callOi += oi;
    } else {
      putVol += vol;
      putPrem += premium;
      putOi += oi;
    }
    if (!Number.isFinite(iv) || iv <= 0 || spot == null || !Number.isFinite(strike)) {
      continue;
    }
    const ivPct = iv * 100;
    const moneyness = (strike - spot) / spot; // negative = below spot
    if (Math.abs(moneyness) <= ATM_BAND_PCT) {
      atmIvs.push(ivPct);
      if (expiry === nearestExpiry) {
        if (type === 'call') nearestAtmCallIvs.push(ivPct);
        else nearestAtmPutIvs.push(ivPct);
      }
    }
    // Risk-reversal wings: same distance band both sides.
    if (type === 'put' && moneyness <= -0.03 && moneyness >= -0.10) {
      otmPutWings.push({ ivPct, expiry });
    } else if (type === 'call' && moneyness >= 0.03 && moneyness <= 0.10) {
      otmCallWings.push({ ivPct, expiry });
    }
  }

  const atmIvPct = median(atmIvs);
  const nearestExpiryDays = nearestExpiry ? daysUntilUtc(nearestExpiry, now) : null;
  const nearestAtmIvPct = robustNearestAtmIv(
    median(nearestAtmCallIvs),
    median(nearestAtmPutIvs),
    atmIvPct,
  );
  const skewPts = robustSkewPts(
    otmPutWings,
    otmCallWings,
    atmIvPct,
    nearestExpiryDays,
    now,
  );
  const prevIv = prev?.atmIvPct ?? null;
  const prevFresh =
    prev?.updatedAt != null && Date.now() - Date.parse(prev.updatedAt) < 26 * 60 * 60 * 1000;
  const totalVol = callVol + putVol;
  const totalOi = callOi + putOi;

  return {
    symbol: ticker,
    proxyFor,
    atmIvPct,
    atmIvChangePts:
      atmIvPct != null && prevIv != null && prevFresh ? atmIvPct - prevIv : null,
    nearestAtmIvPct,
    skewPts,
    pcVolumeRatio: callVol > 0 ? putVol / callVol : null,
    pcPremiumRatio: callPrem > 0 ? putPrem / callPrem : null,
    pcOiRatio: callOi > 0 ? putOi / callOi : null,
    volOiRatio: totalOi > 0 ? totalVol / totalOi : null,
    nearestExpiry,
    nearestExpiryDays,
    contractsSampled: contracts.length,
    updatedAt: now.toISOString(),
  };
}

export async function getEquityOptionsContext(
  hlCoin: string,
  spotHint: number | null,
): Promise<EquityOptionsContext | null> {
  const ticker = resolveOptionsTicker(hlCoin);
  if (!ticker || !config.massiveApiKey) return null;
  const missAt = missingTickerMemo.get(ticker);
  if (missAt != null && Date.now() - missAt < MISSING_RECHECK_MS) return null;

  const proxyFor = metalsOptionsProxy(hlCoin) ? coinPart(hlCoin) : null;
  // Metals: HL GOLD/SILVER $ ≠ GLD/SLV — never center strikes on the metal.
  const strikeSpot =
    proxyFor != null
      ? await fetchProxySpot(ticker, config.massiveApiKey)
      : spotHint;

  const key = `equity_options_${ticker}`;
  const ctx = await getOrRefreshGlobalContext<EquityOptionsContext>({
    key,
    ttlMs: TTL_MS,
    produce: () => produce(ticker, config.massiveApiKey!, strikeSpot, key, proxyFor),
  });
  return ctx && ctx.contractsSampled > 0 ? ctx : null;
}

function pcRead(r: number, putHeavy: string, callHeavy: string): string {
  return r >= 1.3 ? putHeavy : r <= 0.7 ? callHeavy : 'balanced';
}

export type ListedOptionsKind = 'equity' | 'metals';

/**
 * Prompt section for equity or metals HIP-3. Empty for other classes.
 */
export function renderEquityOptionsSection(
  ctx: EquityOptionsContext | null | undefined,
  opts?: { equity?: boolean; metals?: boolean },
): string {
  const kind: ListedOptionsKind | null = opts?.metals
    ? 'metals'
    : opts?.equity
      ? 'equity'
      : null;
  if (!kind) return '';

  if (!ctx) {
    return kind === 'metals'
      ? `

**METALS OPTIONS**: no GLD/SLV listed-options data — do NOT cite options flow, IV, or put/call ratios in your reasoning.`
      : `

**EQUITY OPTIONS**: no listed US options data for this underlier — do NOT cite options flow, IV, or put/call ratios in your reasoning.`;
  }

  const lines: string[] = [];
  if (ctx.atmIvPct != null) {
    const near =
      ctx.nearestAtmIvPct != null && Math.abs(ctx.nearestAtmIvPct - ctx.atmIvPct) >= 1
        ? ` (nearest expiry: ${ctx.nearestAtmIvPct.toFixed(1)}%)`
        : '';
    const chg =
      ctx.atmIvChangePts != null
        ? ` | Δ since last check: ${ctx.atmIvChangePts >= 0 ? '+' : ''}${ctx.atmIvChangePts.toFixed(1)} pts${Math.abs(ctx.atmIvChangePts) >= 3 ? (ctx.atmIvChangePts > 0 ? ' — EXPANDING (event risk being priced; can also be an expiry-roll artifact — cross-check nearest-expiry IV)' : ' — CRUSHING (event passed / fear unwinding)') : ''}`
        : '';
    lines.push(`- ATM IV: ${ctx.atmIvPct.toFixed(1)}% annualized${near}${chg}`);
  }
  if (ctx.skewPts != null) {
    const read =
      ctx.skewPts >= 4
        ? 'STEEP put skew — downside protection strongly bid (institutional hedging / bearish positioning)'
        : ctx.skewPts <= -2
          ? 'INVERTED — upside calls bid over puts (squeeze/chase positioning, unusual for equities)'
          : 'normal';
    lines.push(`- Skew (OTM put IV − call IV, 3–10% wings): ${ctx.skewPts >= 0 ? '+' : ''}${ctx.skewPts.toFixed(1)} pts — ${read}`);
  }
  if (ctx.pcVolumeRatio != null) {
    const prem =
      ctx.pcPremiumRatio != null
        ? ` | premium-weighted: ${ctx.pcPremiumRatio.toFixed(2)} (${pcRead(ctx.pcPremiumRatio, 'downside premium dominant — hedging OR put-selling, aggressor unknown', 'upside premium dominant')})`
        : '';
    lines.push(
      `- Put/Call day volume: ${ctx.pcVolumeRatio.toFixed(2)} (${pcRead(ctx.pcVolumeRatio, 'PUT-heavy', 'CALL-heavy')})${prem}`,
    );
  }
  if (ctx.pcOiRatio != null) {
    lines.push(
      `- Put/Call open interest: ${ctx.pcOiRatio.toFixed(2)} (standing book, slower signal)`,
    );
  }
  if (ctx.volOiRatio != null) {
    lines.push(
      `- Book turnover: day vol / OI = ${ctx.volOiRatio.toFixed(2)}${ctx.volOiRatio >= 0.4 ? ' — ELEVATED, new positioning entering today' : ' — routine'}`,
    );
  }
  if (ctx.nearestExpiry != null) {
    lines.push(
      `- Nearest expiry: ${ctx.nearestExpiry}${ctx.nearestExpiryDays != null ? ` (${ctx.nearestExpiryDays}d)` : ''} — pinning/gamma effects strongest into expiry`,
    );
  }
  if (lines.length === 0) return '';

  if (kind === 'metals') {
    const metal = ctx.proxyFor ?? 'metal';
    return `

**METALS OPTIONS — PRIMARY SIGNAL (${ctx.symbol} ETF proxy for ${metal}, listed US chain, near-ATM ≤3wk window, ~15min delayed)**:
${lines.join('\n')}
- How to use: LEAD reasoning with this block + DXY (MACRO BETA). ${ctx.symbol} options are where US metals positioning shows — weight ATM IV / put-call above HL venue OI/CVD. Strong USD (DXY uptrend) usually weighs on ${metal}; rising metals IV into FOMC/CPI = event risk priced (smaller size / wider stops). No corporate earnings for ${metal}.`;
  }

  return `

**EQUITY OPTIONS — PRIMARY SIGNAL (${ctx.symbol}, listed US chain, near-ATM ≤3wk window, ~15min delayed)**:
${lines.join('\n')}
- How to use: LEAD every reasoning paragraph with this block. Listed options show REAL stock positioning — weight ATM IV / skew / put-call above perp OI, CVD, and premium for this HIP-3 equity. Skew is the institutional directional tell; volume ratios show activity but NOT aggressor direction — don't over-read them. High ATM IV into earnings = gap priced in (favor smaller size / wider stops, not necessarily FLAT). IV crush after the print often strands late momentum entries.`;
}
