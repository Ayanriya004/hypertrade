/**
 * useLiveQuote — generic "live quote with expiry + silent auto-refresh".
 *
 * For any flow where the quoted output decays (FX, aggregator swap, or
 * cross-chain fee) and the provider issues a short-lived quote, this owns:
 *   - the current quote + its TTL
 *   - a client-side countdown (no clock-skew: counts from when the quote
 *     landed on-device)
 *   - a silent auto-refresh a few seconds before expiry, so the displayed
 *     quote is always submittable
 *   - a tap-to-refresh entry point
 *
 * It is provider-agnostic: pass a `refetch()` that returns the next quote
 * (typically reusing a cached auth signature, so refresh never re-prompts).
 *
 * Used by WithdrawBottomSheet today; designed to drop straight into a future
 * multi-asset Add Money flow (USDT/ETH -> USD24) which has the same shape.
 * Pair it with `components/bank/QuoteCountdownRing.tsx` for the UI.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

const DEFAULT_TTL_SECONDS = 30;
const DEFAULT_REFRESH_THRESHOLD_SECONDS = 3;
const DEFAULT_TICK_MS = 250;
// Floor between auto-refresh attempts so a transient failure (which doesn't
// reset the clock) can't hammer the backend every tick.
const MIN_REFRESH_INTERVAL_MS = 2000;

export interface UseLiveQuoteOptions<T> {
  /** Only count down + auto-refresh while true (e.g. stage === 'review'). */
  active: boolean;
  /** Re-fetch the quote. Should reuse any cached auth so it never re-prompts. */
  refetch: () => Promise<{ quote: T; ttlSeconds?: number }>;
  /** Classify a refresh failure as terminal (e.g. region gate / expired). */
  isHardError?: (detail: string) => boolean;
  /** Called when a refresh hits a hard error — caller flips to its error UI. */
  onHardError?: (detail: string) => void;
  refreshThresholdSeconds?: number;
  tickMs?: number;
  fallbackTtlSeconds?: number;
}

export interface UseLiveQuoteResult<T> {
  quote: T | null;
  ttl: number;
  secondsLeft: number;
  /** Remaining fraction of TTL, 0..1 — feed straight to QuoteCountdownRing. */
  fraction: number;
  refreshing: boolean;
  /** Seed the initial quote (from the first fetch) and start the clock. */
  seed: (quote: T, ttlSeconds?: number) => void;
  /** Force an immediate refresh (tap-to-refresh). */
  refreshNow: () => Promise<void>;
  /** Clear quote + timers (on close / input change). */
  reset: () => void;
}

export function useLiveQuote<T>(opts: UseLiveQuoteOptions<T>): UseLiveQuoteResult<T> {
  const {
    active,
    refetch,
    isHardError,
    onHardError,
    refreshThresholdSeconds = DEFAULT_REFRESH_THRESHOLD_SECONDS,
    tickMs = DEFAULT_TICK_MS,
    fallbackTtlSeconds = DEFAULT_TTL_SECONDS,
  } = opts;

  const [quote, setQuote] = useState<T | null>(null);
  const [ttl, setTtl] = useState(fallbackTtlSeconds);
  const [fetchedAt, setFetchedAt] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const lastRefreshAtRef = useRef(0);

  // Keep `refetch` in a ref so the ticker effect doesn't tear down/rebuild
  // every render when the caller passes an inline closure.
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;
  const isHardErrorRef = useRef(isHardError);
  isHardErrorRef.current = isHardError;
  const onHardErrorRef = useRef(onHardError);
  onHardErrorRef.current = onHardError;

  const seed = useCallback((q: T, ttlSeconds?: number) => {
    const t = ttlSeconds && ttlSeconds > 0 ? ttlSeconds : fallbackTtlSeconds;
    setQuote(q);
    setTtl(t);
    setSecondsLeft(t);
    setFetchedAt(Date.now());
  }, [fallbackTtlSeconds]);

  const reset = useCallback(() => {
    setQuote(null);
    setFetchedAt(0);
    setSecondsLeft(0);
    setRefreshing(false);
    refreshingRef.current = false;
    lastRefreshAtRef.current = 0;
  }, []);

  const refreshNow = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    lastRefreshAtRef.current = Date.now();
    setRefreshing(true);
    try {
      const { quote: q, ttlSeconds } = await refetchRef.current();
      const t = ttlSeconds && ttlSeconds > 0 ? ttlSeconds : fallbackTtlSeconds;
      setQuote(q);
      setTtl(t);
      setSecondsLeft(t);
      setFetchedAt(Date.now());
    } catch (err: unknown) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
        (err as { message?: string })?.message ?? '';
      const hard = isHardErrorRef.current?.(String(detail)) ?? false;
      if (hard) onHardErrorRef.current?.(String(detail));
      // Transient failures keep the old quote; the next tick retries.
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, [fallbackTtlSeconds]);

  // Countdown ticker — only while active. Auto-refreshes near expiry.
  useEffect(() => {
    if (!active || !fetchedAt) return undefined;
    const tick = () => {
      const elapsed = (Date.now() - fetchedAt) / 1000;
      const left = Math.max(0, ttl - elapsed);
      setSecondsLeft(left);
      if (
        left <= refreshThresholdSeconds &&
        !refreshingRef.current &&
        Date.now() - lastRefreshAtRef.current > MIN_REFRESH_INTERVAL_MS
      ) {
        void refreshNow();
      }
    };
    tick();
    const id = setInterval(tick, tickMs);
    return () => clearInterval(id);
  }, [active, fetchedAt, ttl, refreshThresholdSeconds, tickMs, refreshNow]);

  const fraction = ttl > 0 ? Math.max(0, Math.min(1, secondsLeft / ttl)) : 0;

  return { quote, ttl, secondsLeft, fraction, refreshing, seed, refreshNow, reset };
}
