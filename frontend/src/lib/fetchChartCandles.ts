import { fetchCandles, type Candle } from './api';
import {
  isCalendarMonthInterval,
  aggregateDailyToCalendarMonths,
  dailyLimitForMonthBars,
  calendarMonthsLookbackMs,
} from './calendarMonthCandles';

/**
 * Chart candle fetch: `1M` is built from `1d` into UTC calendar months (1st 00:00 UTC).
 * All other intervals pass through to Hyperliquid unchanged.
 */
export async function fetchChartCandles(
  coin: string,
  interval: string,
  limit: number,
  startTime?: number,
  endTime?: number,
): Promise<{ candles: Candle[]; coin: string; interval: string }> {
  if (!isCalendarMonthInterval(interval)) {
    return fetchCandles(coin, interval, limit, startTime, endTime);
  }

  const end = endTime ?? Date.now();
  const start = startTime != null ? startTime : end - calendarMonthsLookbackMs(limit);
  const dailyLimit = dailyLimitForMonthBars(
    startTime != null ? Math.max(limit, Math.ceil((end - start) / (31 * 86_400_000)) + 2) : limit,
  );

  const res = await fetchCandles(coin, '1d', dailyLimit, start, end);
  const candles = aggregateDailyToCalendarMonths(res.candles);
  return { candles, coin: res.coin, interval };
}
