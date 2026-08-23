import type { UpcomingCalendarEvent } from '../data/macroCalendar.js';

export type SessionLabel = 'US' | 'Europe' | 'Asia';

export interface SessionContext {
  label: SessionLabel;
  sessionWindowUTC: string;
  isUsSession: boolean;
  /**
   * Thin-liquidity window (not calendar Sat/Sun):
   * Friday 19:00 UTC inclusive → Sunday 21:00 UTC exclusive.
   * Skips the last US Friday hour; releases before Asia open Sunday
   * so Monday-Asia hours can run at full (aggressive) appetite.
   */
  isWeekend: boolean;
  timestamp: string;
  /**
   * Relative calendar slice (next ~7 days: US holidays + high-impact macro).
   * Filled by the cycle (async, globally cached) — getSessionContext itself
   * stays sync/pure.
   */
  upcomingEvents?: UpcomingCalendarEvent[];
}

/**
 * Crypto thin-hours: Fri 19:00 UTC ≤ t < Sun 21:00 UTC.
 * Half-open so the Sun 21:00 hourly cycle is already "weekday".
 */
export function isThinLiquidityWindow(dateInput: Date = new Date()): boolean {
  const date = new Date(dateInput);
  const day = date.getUTCDay(); // 0 Sun … 5 Fri … 6 Sat
  const hour = date.getUTCHours();
  const minute = date.getUTCMinutes();
  const hm = hour + minute / 60;

  if (day === 5) return hm >= 19; // Friday from 19:00
  if (day === 6) return true; // all Saturday
  if (day === 0) return hm < 21; // Sunday until 21:00
  return false;
}

export function getSessionContext(dateInput: Date = new Date()): SessionContext {
  const date = new Date(dateInput);
  const utcHour = date.getUTCHours();
  const isWeekend = isThinLiquidityWindow(date);

  let label: SessionLabel;
  let window: string;

  if (utcHour >= 13 && utcHour < 21) {
    label = 'US';
    window = '13:00–21:00';
  } else if (utcHour >= 7 && utcHour < 13) {
    label = 'Europe';
    window = '07:00–13:00';
  } else {
    label = 'Asia';
    window = '21:00–07:00';
  }

  return {
    label,
    sessionWindowUTC: `${window} UTC`,
    isUsSession: label === 'US',
    isWeekend,
    timestamp: date.toISOString(),
  };
}
