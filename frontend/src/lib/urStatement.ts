/** Date-range helpers for UR account statement export. */

export type StatementPreset = '1m' | '3m' | '6m' | '1y' | 'custom';
export type StatementDirection = 'ALL' | 'IN' | 'OUT';

export interface MonthYear {
  year: number;
  /** 1–12 */
  month: number;
}

export interface StatementRange {
  from_timestamp: number;
  to_timestamp: number;
  from: MonthYear;
  to: MonthYear;
}

export const MAX_STATEMENT_RANGE_SECONDS = 366 * 24 * 3600;

export function startOfMonthUtc({ year, month }: MonthYear): number {
  return Math.floor(Date.UTC(year, month - 1, 1, 0, 0, 0) / 1000);
}

export function endOfMonthUtc({ year, month }: MonthYear): number {
  return Math.floor(Date.UTC(year, month, 0, 23, 59, 59) / 1000);
}

export function nowUtcSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function monthYearFromDate(d: Date): MonthYear {
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

export function formatMonthYear({ year, month }: MonthYear): string {
  const d = new Date(Date.UTC(year, month - 1, 1));
  return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function formatMonthYearNumeric({ year, month }: MonthYear): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function addMonths({ year, month }: MonthYear, delta: number): MonthYear {
  const d = new Date(Date.UTC(year, month - 1 + delta, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

export function rangeFromMonths(from: MonthYear, to: MonthYear): StatementRange {
  const fromTs = startOfMonthUtc(from);
  const toTs = endOfMonthUtc(to);
  return {
    from_timestamp: Math.min(fromTs, toTs),
    to_timestamp: Math.max(fromTs, toTs),
    from: fromTs <= toTs ? from : to,
    to: fromTs <= toTs ? to : from,
  };
}

export function validateStatementRange(fromTs: number, toTs: number): string | null {
  if (toTs < fromTs) return 'invalid_range';
  if (toTs - fromTs > MAX_STATEMENT_RANGE_SECONDS) return 'range_too_long';
  return null;
}

/** Current calendar month from the 1st through today (UTC). */
export function presetThisMonth(now = new Date()): StatementRange {
  const cur = monthYearFromDate(now);
  return {
    from_timestamp: startOfMonthUtc(cur),
    to_timestamp: nowUtcSeconds(),
    from: cur,
    to: cur,
  };
}

/** Last N calendar months from month start through today (UTC). */
export function presetLastNMonths(n: number, now = new Date()): StatementRange {
  const end = monthYearFromDate(now);
  const start = addMonths(end, -(n - 1));
  return {
    from_timestamp: startOfMonthUtc(start),
    to_timestamp: nowUtcSeconds(),
    from: start,
    to: end,
  };
}

export function presetRange(preset: Exclude<StatementPreset, 'custom'>, now = new Date()): StatementRange {
  switch (preset) {
    case '1m':
      return presetThisMonth(now);
    case '3m':
      return presetLastNMonths(3, now);
    case '6m':
      return presetLastNMonths(6, now);
    case '1y':
      return presetLastNMonths(12, now);
    default:
      return presetThisMonth(now);
  }
}

export function formatShortDateUtc(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Explicit from–to dates for the selected statement window (UTC). */
export function formatStatementPeriodRange(range: StatementRange): string {
  return `${formatShortDateUtc(range.from_timestamp)} – ${formatShortDateUtc(range.to_timestamp)}`;
}

/** Human-readable period line for preset chips (not custom month steppers). */
export function formatPresetPeriodHint(
  range: StatementRange,
  _preset: Exclude<StatementPreset, 'custom'>,
): string {
  return formatStatementPeriodRange(range);
}

export function maskEmail(email?: string | null): string {
  if (!email?.includes('@')) return '—';
  const [local, domain] = email.split('@');
  if (!local || !domain) return '—';
  const visible = local.slice(0, Math.min(3, local.length));
  const masked = '*'.repeat(Math.max(2, local.length - visible.length));
  return `${visible}${masked}@${domain}`;
}

export const STATEMENT_CURRENCY_OPTIONS = [
  'USD',
  'CHF',
  'EUR',
  'CNH',
  'GBP',
  'JPY',
  'SGD',
  'HKD',
] as const;

/** USD first, then remaining fiat codes alphabetically. */
export function sortStatementCurrencies(codes: string[]): string[] {
  const set = new Set(codes.map((c) => c.toUpperCase()));
  const rest = [...set].filter((c) => c !== 'USD').sort();
  return set.has('USD') ? ['USD', ...rest] : rest;
}
