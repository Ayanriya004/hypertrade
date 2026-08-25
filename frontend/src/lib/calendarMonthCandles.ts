import type { Candle } from './api';

/** Chart interval label for calendar-month bars (not HL's 30-day `1M`). */
export const CALENDAR_MONTH_INTERVAL = '1M';
/** Chart interval label for Monday-UTC week bars (not HL's Thursday-aligned `1w`). */
export const CALENDAR_WEEK_INTERVAL = '1w';

export function isCalendarMonthInterval(interval: string): boolean {
  return interval === CALENDAR_MONTH_INTERVAL;
}

export function isCalendarWeekInterval(interval: string): boolean {
  return interval === CALENDAR_WEEK_INTERVAL;
}

export function isCalendarBarInterval(interval: string): boolean {
  return isCalendarMonthInterval(interval) || isCalendarWeekInterval(interval);
}

/** UTC calendar month open in seconds (Lightweight Charts unix time). */
export function utcMonthStartSec(tsSec: number): number {
  const d = new Date(tsSec * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);
}

export function utcMonthStartMs(tsMs: number): number {
  return utcMonthStartSec(Math.floor(tsMs / 1000)) * 1000;
}

/** Daily bars needed to cover `monthBars` calendar months (HL caps at 5000). */
export function dailyLimitForMonthBars(monthBars: number): number {
  return Math.min(5000, Math.ceil(monthBars * 31) + 31);
}

/** Approximate lookback window for pagination / default history range. */
export function calendarMonthsLookbackMs(monthCount: number): number {
  return monthCount * 31 * 86_400_000;
}

/** UTC week open: Monday 00:00 UTC (ISO weekday). HL native `1w` is epoch/Thursday. */
export function utcMondayStartSec(tsSec: number): number {
  const d = new Date(tsSec * 1000);
  const daysFromMonday = (d.getUTCDay() + 6) % 7;
  return Math.floor(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysFromMonday) / 1000,
  );
}

export function utcMondayStartMs(tsMs: number): number {
  return utcMondayStartSec(Math.floor(tsMs / 1000)) * 1000;
}

export function dailyLimitForWeekBars(weekBars: number): number {
  return Math.min(5000, Math.ceil(weekBars * 7) + 7);
}

export function calendarWeeksLookbackMs(weekCount: number): number {
  return weekCount * 7 * 86_400_000;
}

function normalizeDailyTimeMs(raw: number): number {
  let t = Number(raw);
  if (!Number.isFinite(t)) return NaN;
  if (t < 1e12) t *= 1000;
  return Math.floor(t);
}

/**
 * Roll daily HL candles into UTC calendar-month OHLCV (open on the 1st 00:00 UTC).
 */
export function aggregateDailyToCalendarMonths(daily: Candle[]): Candle[] {
  return aggregateDailyToBuckets(daily, utcMonthStartMs);
}

/** Roll daily HL candles into Monday-UTC week OHLCV. */
export function aggregateDailyToCalendarWeeks(daily: Candle[]): Candle[] {
  return aggregateDailyToBuckets(daily, utcMondayStartMs);
}

function aggregateDailyToBuckets(daily: Candle[], keyMs: (tMs: number) => number): Candle[] {
  if (!daily?.length) return [];

  type Day = {
    t: number;
    o: number;
    h: number;
    l: number;
    c: number;
    v: number;
    n: number;
  };

  const sorted: Day[] = daily
    .map((c) => ({
      t: normalizeDailyTimeMs(c.t),
      o: parseFloat(String(c.o)),
      h: parseFloat(String(c.h)),
      l: parseFloat(String(c.l)),
      c: parseFloat(String(c.c)),
      v: parseFloat(String(c.v ?? '0')),
      n: (c as { n?: number }).n != null ? Number((c as { n?: number }).n) : 0,
    }))
    .filter(
      (c) =>
        Number.isFinite(c.t) &&
        Number.isFinite(c.o) &&
        Number.isFinite(c.h) &&
        Number.isFinite(c.l) &&
        Number.isFinite(c.c),
    )
    .sort((a, b) => a.t - b.t);

  const bars: Candle[] = [];
  let cur: Day | null = null;
  let curKey = -1;

  const flush = () => {
    if (!cur) return;
    bars.push({
      t: curKey,
      o: String(cur.o),
      h: String(cur.h),
      l: String(cur.l),
      c: String(cur.c),
      v: String(cur.v),
      ...(cur.n > 0 ? { n: cur.n } : {}),
    });
  };

  for (const d of sorted) {
    const key = keyMs(d.t);
    if (curKey !== key) {
      flush();
      curKey = key;
      cur = { t: key, o: d.o, h: d.h, l: d.l, c: d.c, v: d.v, n: d.n };
    } else if (cur) {
      cur.h = Math.max(cur.h, d.h);
      cur.l = Math.min(cur.l, d.l);
      cur.c = d.c;
      cur.v += d.v;
      cur.n += d.n;
    }
  }
  flush();
  return bars;
}

export type MonthBar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trades?: number;
};

function foldDailyLiveIntoBucket(
  daily: MonthBar,
  seed: MonthBar | null,
  bucketStart: number,
): MonthBar {
  if (seed && seed.time === bucketStart) {
    return {
      time: bucketStart,
      open: seed.open,
      high: Math.max(seed.high, daily.high),
      low: Math.min(seed.low, daily.low),
      close: daily.close,
      volume: seed.volume,
      trades: seed.trades,
    };
  }

  return {
    time: bucketStart,
    open: daily.open,
    high: daily.high,
    low: daily.low,
    close: daily.close,
    volume: daily.volume,
    trades: daily.trades,
  };
}

function dailyTimeSec(daily: MonthBar): number {
  return daily.time > 1e12 ? Math.floor(daily.time / 1000) : daily.time;
}

/** Fold a live daily WS candle into the active calendar-month bar. */
export function foldDailyLiveIntoMonthBar(
  daily: MonthBar,
  seed: MonthBar | null,
): MonthBar {
  return foldDailyLiveIntoBucket(daily, seed, utcMonthStartSec(dailyTimeSec(daily)));
}

/** Fold a live daily WS candle into the active Monday-UTC week bar. */
export function foldDailyLiveIntoWeekBar(
  daily: MonthBar,
  seed: MonthBar | null,
): MonthBar {
  return foldDailyLiveIntoBucket(daily, seed, utcMondayStartSec(dailyTimeSec(daily)));
}
