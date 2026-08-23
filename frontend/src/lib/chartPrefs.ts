import AsyncStorage from '@react-native-async-storage/async-storage';

const CHART_PREFS_KEY = 'chartPrefs';
const LAST_OWNER_STORAGE_KEY = 'chartPrefs:lastOwner';

/** Main-chart overlay groups; value `false` = lines hidden for that group (eye off). Omitted/`true` = shown. */
export type MainIndicatorLineGroup = 'ema' | 'ma' | 'boll' | 'vwap' | 'supertrend';

export type MainIndicatorLineVisibility = Partial<Record<MainIndicatorLineGroup, boolean>>;

export type ChartPrefs = {
  useUtc?: boolean;
  showOrderLines?: boolean;
  showHighLow?: boolean;
  showOhlcvHud?: boolean;
  showTradeMarkers?: boolean;
  drawingEnabled?: boolean;
  /** @deprecated migrated to mainIndicatorLineVisibility */
  hideMainIndicatorLines?: boolean;
  mainIndicatorLineVisibility?: MainIndicatorLineVisibility;
  primaryIntervals?: string[];
};

/**
 * In-memory mirror of saved chart prefs (pinned intervals, HUD toggles, …).
 * AsyncStorage is async, so a fresh AssetChart mount would otherwise paint
 * the default interval chips (`15m 1h 4h 1d`) then snap to the user's
 * longer pinned set. Primed at app boot via `primeChartPrefsCache`.
 */
const cachedByOwner = new Map<string, ChartPrefs>();
let lastOwnerKey: string | null = null;

function ownerKey(ownerId?: string | null) {
  return ownerId ?? 'guest';
}

function getStorageKey(ownerId?: string | null) {
  return `${CHART_PREFS_KEY}:${ownerKey(ownerId)}`;
}

function rememberOwner(ownerId?: string | null) {
  lastOwnerKey = ownerKey(ownerId);
}

function cachePrefs(ownerId: string | null | undefined, prefs: ChartPrefs) {
  const key = ownerKey(ownerId);
  cachedByOwner.set(key, prefs);
  rememberOwner(ownerId);
}

/** Exact owner only — safe to treat as "hydrated for this account". */
export function getCachedChartPrefsExact(ownerId?: string | null): ChartPrefs | null {
  return cachedByOwner.get(ownerKey(ownerId)) ?? null;
}

/**
 * Prefs for first paint. Falls back to the last primed owner only while
 * `ownerId` is still anonymous so we don't flash another account's pins
 * after a user switch.
 */
export function getCachedChartPrefs(ownerId?: string | null): ChartPrefs | null {
  const exact = getCachedChartPrefsExact(ownerId);
  if (exact) return exact;
  if (ownerId == null || ownerId === '') {
    if (lastOwnerKey) return cachedByOwner.get(lastOwnerKey) ?? null;
  }
  return null;
}

export function applyChartPrefs<T extends Record<string, unknown>>(
  prev: T,
  prefs: ChartPrefs,
): T {
  const merged = { ...prev, ...prefs } as T & ChartPrefs;
  if (prefs.hideMainIndicatorLines === true && !prefs.mainIndicatorLineVisibility) {
    merged.mainIndicatorLineVisibility = {
      ema: false,
      ma: false,
      boll: false,
      vwap: false,
      supertrend: false,
    };
  }
  delete (merged as { hideMainIndicatorLines?: boolean }).hideMainIndicatorLines;
  return merged;
}

async function persistLastOwner(ownerId?: string | null) {
  rememberOwner(ownerId);
  try {
    await AsyncStorage.setItem(LAST_OWNER_STORAGE_KEY, ownerKey(ownerId));
  } catch {
    // ignore storage errors
  }
}

export async function loadChartPrefs(ownerId?: string | null): Promise<ChartPrefs | null> {
  try {
    const raw = await AsyncStorage.getItem(getStorageKey(ownerId));
    const prefs = raw ? (JSON.parse(raw) as ChartPrefs) : null;
    if (prefs) cachePrefs(ownerId, prefs);
    void persistLastOwner(ownerId);
    return prefs;
  } catch {
    return null;
  }
}

export async function saveChartPrefs(ownerId: string | null | undefined, prefs: ChartPrefs) {
  cachePrefs(ownerId, prefs);
  try {
    await AsyncStorage.setItem(getStorageKey(ownerId), JSON.stringify(prefs));
    await persistLastOwner(ownerId);
  } catch {
    // ignore storage errors
  }
}

/**
 * Prime the in-memory cache from storage so the first chart mount of the
 * session can render the user's pinned intervals without a default-chip flash.
 */
export async function primeChartPrefsCache(): Promise<void> {
  if (lastOwnerKey && cachedByOwner.has(lastOwnerKey)) return;
  try {
    let owner = await AsyncStorage.getItem(LAST_OWNER_STORAGE_KEY);
    if (!owner) {
      const keys = await AsyncStorage.getAllKeys();
      owner =
        keys.find(
          (k) =>
            k.startsWith(`${CHART_PREFS_KEY}:`) &&
            k !== LAST_OWNER_STORAGE_KEY &&
            k !== `${CHART_PREFS_KEY}:guest`,
        )?.slice(CHART_PREFS_KEY.length + 1) ??
        (keys.includes(`${CHART_PREFS_KEY}:guest`) ? 'guest' : null);
    }
    if (!owner) return;
    await loadChartPrefs(owner === 'guest' ? null : owner);
  } catch {
    // ignore — chart will fade chips in after its own hydrate
  }
}
