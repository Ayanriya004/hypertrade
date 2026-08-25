import { fetchCandles, type Candle } from './api';
import {
  isCalendarMonthInterval,
  isCalendarWeekInterval,
  aggregateDailyToCalendarMonths,
  aggregateDailyToCalendarWeeks,
  dailyLimitForMonthBars,
  dailyLimitForWeekBars,
  calendarMonthsLookbackMs,
  calendarWeeksLookbackMs,
} from './calendarMonthCandles';

/**
 * Chart candle fetch:
 * - `1M` is built from `1d` into UTC calendar months (1st 00:00 UTC).
 * - `1w` is built from `1d` into UTC weeks (Monday 00:00 UTC). HL native `1w` is Thursday-aligned.
 * All other intervals pass through to Hyperliquid unchanged.
 */
export async function fetchChartCandles(
  coin: string,
  interval: string,
  limit: number,
  startTime?: number,
  endTime?: number,
): Promise<{ candles: Candle[]; coin: string; interval: string }> {
  if (isCalendarMonthInterval(interval)) {
    const end = endTime ?? Date.now();
    const start = startTime != null ? startTime : end - calendarMonthsLookbackMs(limit);
    const dailyLimit = dailyLimitForMonthBars(
      startTime != null ? Math.max(limit, Math.ceil((end - start) / (31 * 86_400_000)) + 2) : limit,
    );

    const res = await fetchCandles(coin, '1d', dailyLimit, start, end);
    const candles = aggregateDailyToCalendarMonths(res.candles);
    return { candles, coin: res.coin, interval };
  }

  if (isCalendarWeekInterval(interval)) {
    const end = endTime ?? Date.now();
    const start = startTime != null ? startTime : end - calendarWeeksLookbackMs(limit);
    const dailyLimit = dailyLimitForWeekBars(
      startTime != null ? Math.max(limit, Math.ceil((end - start) / (7 * 86_400_000)) + 2) : limit,
    );

    const res = await fetchCandles(coin, '1d', dailyLimit, start, end);
    const candles = aggregateDailyToCalendarWeeks(res.candles);
    return { candles, coin: res.coin, interval };
  }

  return fetchCandles(coin, interval, limit, startTime, endTime);
}
