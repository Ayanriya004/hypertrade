/**
 * Next earnings date from Supabase `earnings_cache` (filled by the API).
 * Equity HIP-3 only. Null/missing dates are common (not announced yet) —
 * prompts must say so explicitly and MUST NOT invent a date or apply the
 * 48h open gate.
 */
import { assetClassOf, coinPart, isHip3Symbol } from '../brain/assetClass.js';
import { getSupabase } from '../lib/supabase.js';

export interface EarningsContext {
  symbol: string;
  nextDate: string; // YYYY-MM-DD
  daysUntil: number;
  /** True when next earnings is today or tomorrow (UTC calendar). */
  within48h: boolean;
}

function utcYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysBetweenUtc(fromYmd: string, toYmd: string): number {
  const a = Date.parse(`${fromYmd}T00:00:00Z`);
  const b = Date.parse(`${toYmd}T00:00:00Z`);
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

export async function getEarningsContext(
  hlCoin: string,
  now: Date = new Date(),
): Promise<EarningsContext | null> {
  if (!isHip3Symbol(hlCoin)) return null;
  if (assetClassOf(hlCoin) !== 'equity') return null;
  const symbol = coinPart(hlCoin);
  try {
    const { data } = await getSupabase()
      .from('earnings_cache')
      .select('next_earnings_date')
      .eq('symbol', symbol)
      .maybeSingle();
    const next = data?.next_earnings_date as string | null | undefined;
    if (!next) return null;
    const today = utcYmd(now);
    if (next < today) return null;
    const daysUntil = daysBetweenUtc(today, next);
    return {
      symbol,
      nextDate: next,
      daysUntil,
      within48h: daysUntil <= 1,
    };
  } catch (err) {
    console.warn(
      `[earnings] lookup failed for ${symbol}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Equity HIP-3 always gets an earnings line — either the date or an
 * explicit "not announced" so the model doesn't hallucinate one.
 * Non-equity: empty (commodities/FX/indices don't report earnings).
 */
export function renderEarningsSection(
  ctx: EarningsContext | null | undefined,
  opts?: { equity?: boolean },
): string {
  if (!opts?.equity) return '';
  if (!ctx) {
    return `

**EARNINGS**:
- Next report date: **not announced / unavailable** — do **not** invent a date; do **not** apply an earnings-window size/FLAT gate.`;
  }
  const urgency = ctx.within48h
    ? '⚠️ INSIDE 48h WINDOW — prefer FLAT on fresh opens unless conviction is high; existing positions: size down risk / widen awareness of gap'
    : ctx.daysUntil <= 7
      ? 'Within a week — factor into stop width and size'
      : 'On the calendar';
  return `

**EARNINGS**:
- Next report: **${ctx.nextDate}** (${ctx.daysUntil === 0 ? 'TODAY' : ctx.daysUntil === 1 ? 'tomorrow' : `in ${ctx.daysUntil} days`}) — ${urgency}`;
}
