import type { Candle } from './api';

/** Chart interval label for calendar-month bars (not HL's 30-day `1M`). */
export const CALENDAR_MONTH_INTERVAL = '1M';

export function isCalendarMonthInterval(interval: string): boolean {
  return interval === CALENDAR_MONTH_INTERVAL;
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

  const months: Candle[] = [];
  let cur: Day | null = null;
  let curKey = -1;

  const flush = () => {
    if (!cur) return;
    months.push({
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
    const key = utcMonthStartMs(d.t);
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
  return months;
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

/** Fold a live daily WS candle into the active calendar-month bar. */
export function foldDailyLiveIntoMonthBar(
  daily: MonthBar,
  seed: MonthBar | null,
): MonthBar {
  const dailySec = daily.time > 1e12 ? Math.floor(daily.time / 1000) : daily.time;
  const monthStart = utcMonthStartSec(dailySec);

  if (seed && seed.time === monthStart) {
    return {
      time: monthStart,
      open: seed.open,
      high: Math.max(seed.high, daily.high),
      low: Math.min(seed.low, daily.low),
      close: daily.close,
      volume: seed.volume,
      trades: seed.trades,
    };
  }

  return {
    time: monthStart,
    open: daily.open,
    high: daily.high,
    low: daily.low,
    close: daily.close,
    volume: daily.volume,
    trades: daily.trades,
  };
}
