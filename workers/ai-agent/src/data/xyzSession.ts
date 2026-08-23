/**
 * tradeXYZ / HIP-3 underlying-session context for prompts.
 *
 * The book trades ~24/7, but price discovery switches between EXTERNAL
 * (underlying cash/futures open) and INTERNAL (EMA from last external
 * close, constrained by discovery bounds). Schedules from tradeXYZ docs
 * (America/New_York). Margin mode is NOT inferred here — some xyz markets
 * support cross, some are isolated-only; always use live HL meta.
 *
 * @see https://docs.trade.xyz/perp-mechanics/discovery-bounds
 * @see https://docs.trade.xyz/consolidated-resources/specification-index
 */
import {
  assetClassOf,
  classLabel,
  coinPart,
  isHip3Symbol,
  type AssetClass,
} from '../brain/assetClass.js';

export type XyzPricingMode = 'external' | 'internal' | 'maintenance';

export interface XyzSessionContext {
  symbol: string;
  coin: string;
  assetClass: AssetClass;
  pricingMode: XyzPricingMode;
  /** Short human label for the active window. */
  windowLabel: string;
  /** Approximate instantaneous discovery band (±1/maxLev) when known. */
  discoveryBoundPct: number | null;
  notes: string[];
}

/** ET wall-clock parts via America/New_York (handles EST/EDT). */
function etParts(now: Date): { dow: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(now);
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  const dowMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return { dow: dowMap[weekday] ?? 1, hour, minute };
}

function etMinutes(hour: number, minute: number): number {
  return hour * 60 + minute;
}

/**
 * US single-name equities: external Sun 20:00 → Fri 20:00 ET;
 * internal Fri 20:00 → Sun 20:00 ET (+ equity holidays treated as internal).
 */
function equityPricingMode(et: { dow: number; hour: number; minute: number }): XyzPricingMode {
  const m = etMinutes(et.hour, et.minute);
  const friClose = etMinutes(20, 0);
  const sunOpen = etMinutes(20, 0);
  if (et.dow === 6) return 'internal'; // Saturday
  if (et.dow === 5 && m >= friClose) return 'internal';
  if (et.dow === 0 && m < sunOpen) return 'internal';
  return 'external';
}

/**
 * Equity indices + commodities: external Sun 18:00 → Fri 17:00 ET;
 * daily maintenance Mon–Thu 17:00–18:00 ET; internal Fri 17:00 → Sun 18:00.
 */
function indexCommodityPricingMode(et: {
  dow: number;
  hour: number;
  minute: number;
}): XyzPricingMode {
  const m = etMinutes(et.hour, et.minute);
  const friClose = etMinutes(17, 0);
  const sunOpen = etMinutes(18, 0);
  const maintStart = etMinutes(17, 0);
  const maintEnd = etMinutes(18, 0);
  if (et.dow === 6) return 'internal';
  if (et.dow === 5 && m >= friClose) return 'internal';
  if (et.dow === 0 && m < sunOpen) return 'internal';
  // Mon–Thu 17:00–18:00 ET maintenance gap
  if (et.dow >= 1 && et.dow <= 4 && m >= maintStart && m < maintEnd) return 'maintenance';
  return 'external';
}

/** FX: external Sun 17:00 → Fri 17:00 ET; internal Fri 17:00 → Sun 17:00. */
function fxPricingMode(et: { dow: number; hour: number; minute: number }): XyzPricingMode {
  const m = etMinutes(et.hour, et.minute);
  const friClose = etMinutes(17, 0);
  const sunOpen = etMinutes(17, 0);
  if (et.dow === 6) return 'internal';
  if (et.dow === 5 && m >= friClose) return 'internal';
  if (et.dow === 0 && m < sunOpen) return 'internal';
  return 'external';
}

/** Discovery band % from tradeXYZ spec. Sparse on purpose — missing coins
 *  fall back to ±(1 / max leverage) in the prompt. Pin a name when the spec
 *  bound differs from that default (e.g. UNITREE 10x but ±20%). */
const DISCOVERY_BOUND_PCT: Record<string, number> = {
  SP500: 2, XYZ100: 3.5, VIX: 33,
  TSLA: 5, NVDA: 5, AAPL: 5, MSFT: 5, AMZN: 5, META: 5, GOOGL: 5, COST: 5, SPCX: 5, SKHY: 5,
  UNITREE: 20,
  GOLD: 4, SILVER: 4, PLATINUM: 5, PALLADIUM: 5, COPPER: 5, CL: 5, BRENTOIL: 5,
  NATGAS: 10, EUR: 2, JPY: 2, GBP: 2, KRW: 2, DXY: 5,
};

function modeForClass(
  cls: AssetClass,
  et: { dow: number; hour: number; minute: number },
): XyzPricingMode {
  if (cls === 'equity') return equityPricingMode(et);
  if (cls === 'forex') return fxPricingMode(et);
  if (cls === 'index' || cls === 'commodity') return indexCommodityPricingMode(et);
  return 'external';
}

function windowLabel(mode: XyzPricingMode, cls: AssetClass): string {
  if (mode === 'maintenance') return 'daily maintenance gap (ET)';
  if (mode === 'internal') {
    if (cls === 'equity') return 'internal / weekend–holiday discovery (ET)';
    if (cls === 'forex') return 'internal FX weekend window (ET)';
    return 'internal / extended-session discovery (ET)';
  }
  if (cls === 'equity') return 'external US equity session (Sun 20:00–Fri 20:00 ET)';
  if (cls === 'forex') return 'external FX session (Sun 17:00–Fri 17:00 ET)';
  return 'external cash/futures session (Sun 18:00–Fri 17:00 ET)';
}

export function getXyzSessionContext(
  symbol: string,
  now: Date = new Date(),
): XyzSessionContext | null {
  if (!isHip3Symbol(symbol)) return null;
  const coin = coinPart(symbol);
  const assetClass = assetClassOf(symbol);
  const et = etParts(now);
  const pricingMode = modeForClass(assetClass, et);
  const discoveryBoundPct = DISCOVERY_BOUND_PCT[coin] ?? null;

  const notes: string[] = [];
  if (pricingMode === 'internal' || pricingMode === 'maintenance') {
    notes.push(
      'Off-session: oracle floats via internal EMA inside discovery bounds — expect thinner flow and mean-reversion; do NOT treat drift as cash-session confirmation.',
    );
    notes.push(
      'Reopen risk: when external pricing resumes, the reference snaps to the live external price — gaps can move mark/funding sharply.',
    );
    if (discoveryBoundPct != null) {
      notes.push(
        `Instantaneous discovery bound ≈ ±${discoveryBoundPct}% of reference (re-anchors may extend the weekend path further before a hard cap).`,
      );
    } else {
      notes.push(
        'Discovery bounds ≈ ±(1 / max leverage) of the reference price; re-anchors may extend weekend range before a hard cap.',
      );
    }
    notes.push(
      'Liquidation may be deferred while liq price sits outside active bounds — that protection ends when external pricing resumes.',
    );
  } else {
    notes.push(
      'External session: oracle tracks the underlying; microstructure + macro both matter.',
    );
  }

  return {
    symbol: symbol.toUpperCase(),
    coin,
    assetClass,
    pricingMode,
    windowLabel: windowLabel(pricingMode, assetClass),
    discoveryBoundPct,
    notes,
  };
}

export function renderXyzSessionSection(ctx: XyzSessionContext | null | undefined): string {
  if (!ctx) return '';
  const mode =
    ctx.pricingMode === 'external'
      ? 'EXTERNAL (underlying open)'
      : ctx.pricingMode === 'maintenance'
        ? 'MAINTENANCE GAP'
        : 'INTERNAL (off-session discovery)';
  const lines = [
    '',
    `**UNDERLYING SESSION** (${classLabel(ctx.assetClass)} · tradeXYZ HIP-3) — silent context; mention in reason only if pricing mode changes the call (e.g. weekend reopen gap):`,
    `- Pricing mode: **${mode}** — ${ctx.windowLabel}`,
  ];
  for (const n of ctx.notes) lines.push(`- ${n}`);
  return lines.join('\n');
}
