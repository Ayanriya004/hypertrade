import AsyncStorage from '@react-native-async-storage/async-storage';

const INTERVAL_PREFS_KEY = 'intervalPrefs:global';

/**
 * Default chart interval used when nothing is saved or the saved value
 * is unrecognized (e.g. older client wrote a now-removed timeframe).
 */
export const DEFAULT_CHART_INTERVAL = '1h';

type IntervalPrefs = {
  /** Last used chart interval — applies globally across all symbols. */
  lastInterval?: string;
};

/**
 * In-memory mirror of the saved interval. AsyncStorage is async, so a
 * fresh chart mount can't read it synchronously — without this cache,
 * the first paint after a symbol switch would always show the default
 * '1h' before flipping to the user's saved value, producing a visible
 * flash. Primed once at app boot via `primeIntervalCache` (called from
 * `_layout.tsx`) so even the very first chart mount of the session
 * starts on the right timeframe.
 *
 * Interval is a UI preference, not an account-specific setting (same
 * model as Binance / Bybit / TradingView), so we deliberately use a
 * single global slot instead of keying by user address.
 */
let cachedInterval: string | null = null;

export async function loadIntervalPrefs(): Promise<IntervalPrefs | null> {
  try {
    const raw = await AsyncStorage.getItem(INTERVAL_PREFS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function saveIntervalPrefs(prefs: IntervalPrefs) {
  try {
    await AsyncStorage.setItem(INTERVAL_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // ignore storage errors
  }
}

/**
 * Synchronous accessor for the in-memory cached interval. Returns
 * `null` if we haven't read storage yet. Use this in a `useState` lazy
 * initializer so the chart can mount on the correct timeframe without
 * a one-frame flash to the default.
 */
export function getCachedInterval(validIntervals: readonly string[]): string | null {
  if (cachedInterval && validIntervals.includes(cachedInterval)) return cachedInterval;
  return null;
}

/**
 * Returns the last-used interval if it's in `validIntervals`, else the
 * default. Also primes the in-memory cache so subsequent reads via
 * `getCachedInterval` are synchronous.
 */
export async function getSavedInterval(
  validIntervals: readonly string[],
  fallback: string = DEFAULT_CHART_INTERVAL,
): Promise<string> {
  const prefs = await loadIntervalPrefs();
  const last = prefs?.lastInterval;
  let resolved: string;
  if (last && validIntervals.includes(last)) resolved = last;
  else resolved = validIntervals.includes(fallback) ? fallback : (validIntervals[0] ?? fallback);
  cachedInterval = resolved;
  return resolved;
}

/**
 * Persist the last used interval globally. Called from the interval
 * switcher so the next chart mount (any symbol) resumes here.
 */
export async function saveLastInterval(interval: string) {
  cachedInterval = interval;
  const prefs = (await loadIntervalPrefs()) ?? {};
  if (prefs.lastInterval === interval) return;
  prefs.lastInterval = interval;
  await saveIntervalPrefs(prefs);
}

/**
 * Prime the in-memory cache from storage. Call this once from the
 * root layout's splash/preflight phase so the first chart mount of the
 * session can read the saved interval synchronously and avoid the
 * '1h -> saved' flash on cold start. Safe to call multiple times.
 */
export async function primeIntervalCache(
  validIntervals: readonly string[] = [],
): Promise<void> {
  if (cachedInterval) return;
  await getSavedInterval(validIntervals);
}
