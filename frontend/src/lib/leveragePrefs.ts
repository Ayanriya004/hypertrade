import AsyncStorage from '@react-native-async-storage/async-storage';

const LEVERAGE_PREFS_KEY = 'leveragePrefs';

// Default leverage when nothing is saved anywhere
const DEFAULT_LEVERAGE = 5;

type MarginType = 'isolated' | 'cross';

type PerSymbolPrefs = {
  leverage?: number;
  marginType?: MarginType;
};

type LeveragePrefs = {
  /** Last used leverage anywhere. Used as fallback for assets the user has not yet visited. */
  lastLeverage?: number;
  /** Last used margin type anywhere. Used as fallback for assets the user has not yet visited. */
  lastMarginType?: MarginType;
  /** Per-asset overrides. Keys are UPPERCASE symbols. Takes priority over lastLeverage/lastMarginType. */
  bySymbol?: Record<string, PerSymbolPrefs>;
};

function getKey(ownerId?: string | null) {
  return `${LEVERAGE_PREFS_KEY}:hl:${ownerId ?? 'guest'}`;
}

function normSymbol(symbol: string | null | undefined): string {
  return String(symbol ?? '').toUpperCase();
}

// Detects the legacy storage shape:
//   { bySymbol: { BTC: 20, ETH: 10 }, global: 5, globalMarginType: 'isolated' }
// where bySymbol values were raw numbers, not objects.
function isLegacyFormat(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object') return false;
  const obj = parsed as Record<string, unknown>;
  if (obj.global !== undefined || obj.globalMarginType !== undefined) return true;
  if (obj.bySymbol && typeof obj.bySymbol === 'object') {
    const firstVal = Object.values(obj.bySymbol as Record<string, unknown>)[0];
    if (firstVal !== undefined && (typeof firstVal === 'number' || typeof firstVal === 'string')) {
      return true;
    }
  }
  return false;
}

export async function loadLeveragePrefs(
  ownerId?: string | null,
): Promise<LeveragePrefs | null> {
  try {
    const key = getKey(ownerId);
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return null;

    const parsed = JSON.parse(raw);

    if (isLegacyFormat(parsed)) {
      const migrated: LeveragePrefs = {
        lastLeverage: parsed.global ?? parsed.lastLeverage ?? DEFAULT_LEVERAGE,
        lastMarginType: parsed.globalMarginType ?? parsed.lastMarginType ?? 'isolated',
        bySymbol: {},
      };
      await AsyncStorage.setItem(key, JSON.stringify(migrated));
      console.log('[LeveragePrefs] Migrated legacy format →', migrated);
      return migrated;
    }

    return parsed as LeveragePrefs;
  } catch (e) {
    console.error('[LeveragePrefs] Error loading:', e);
    return null;
  }
}

export async function saveLeveragePrefs(
  ownerId: string | null | undefined,
  prefs: LeveragePrefs,
) {
  try {
    const key = getKey(ownerId);
    await AsyncStorage.setItem(key, JSON.stringify(prefs));
  } catch (e) {
    console.error('[LeveragePrefs] Error saving:', e);
  }
}

/**
 * Get saved leverage for a specific asset, clamped to that asset's maxLeverage.
 *
 * Lookup order:
 *   1. Per-asset override (prefs.bySymbol[SYMBOL].leverage)
 *   2. Global last-used fallback (prefs.lastLeverage)
 *   3. DEFAULT_LEVERAGE (5)
 * The returned value is always clamped to [1, maxLeverage].
 */
export async function getSavedLeverage(
  ownerId: string | null | undefined,
  symbol: string,
  maxLeverage: number,
): Promise<number> {
  const prefs = await loadLeveragePrefs(ownerId);
  const sym = normSymbol(symbol);
  const perAsset = sym ? prefs?.bySymbol?.[sym]?.leverage : undefined;
  const lev = perAsset ?? prefs?.lastLeverage ?? DEFAULT_LEVERAGE;
  const clamped = Math.min(Math.max(1, lev), Math.max(1, maxLeverage));
  console.log('[LeveragePrefs] getSavedLeverage:', {
    ownerId: ownerId?.slice(0, 10),
    symbol: sym,
    source: perAsset !== undefined ? 'per-asset' : prefs?.lastLeverage !== undefined ? 'global' : 'default',
    raw: lev,
    maxLeverage,
    clamped,
  });
  return clamped;
}

/**
 * Save leverage for a specific asset, and also update the global last-used fallback.
 *
 * The fallback update means a user who changes BTC to 20x will also see 20x the
 * first time they open an asset they've never visited before.
 */
export async function saveLeverageForSymbol(
  ownerId: string | null | undefined,
  symbol: string,
  leverage: number,
  _updateGlobal = true, // kept for API compat; we always update the global fallback
) {
  const sym = normSymbol(symbol);
  if (!sym) {
    console.warn('[LeveragePrefs] saveLeverageForSymbol called with empty symbol – skipping');
    return;
  }
  const prefs = (await loadLeveragePrefs(ownerId)) ?? {};
  prefs.bySymbol = { ...(prefs.bySymbol ?? {}) };
  prefs.bySymbol[sym] = { ...(prefs.bySymbol[sym] ?? {}), leverage };
  prefs.lastLeverage = leverage;
  await saveLeveragePrefs(ownerId, prefs);
  console.log('[LeveragePrefs] saveLeverageForSymbol:', {
    ownerId: ownerId?.slice(0, 10),
    symbol: sym,
    leverage,
  });
}

/**
 * Get saved margin type for a specific asset.
 *
 * Lookup order (identical structure to leverage):
 *   1. Per-asset override
 *   2. Global last-used fallback
 *   3. 'isolated'
 * If the asset does not support cross, 'isolated' is returned regardless.
 */
export async function getSavedMarginType(
  ownerId: string | null | undefined,
  symbol: string,
  supportsCross: boolean,
): Promise<MarginType> {
  const prefs = await loadLeveragePrefs(ownerId);
  const sym = normSymbol(symbol);
  const perAsset = sym ? prefs?.bySymbol?.[sym]?.marginType : undefined;
  const mt: MarginType = perAsset ?? prefs?.lastMarginType ?? 'isolated';
  if (!supportsCross && mt === 'cross') return 'isolated';
  return mt;
}

/**
 * Save margin type for a specific asset, and also update the global last-used fallback.
 * If the asset doesn't support cross, persists 'isolated' instead.
 */
export async function saveMarginTypeForSymbol(
  ownerId: string | null | undefined,
  symbol: string,
  marginType: MarginType,
  supportsCross: boolean,
  _updateGlobal = true, // kept for API compat; we always update the global fallback
) {
  const sym = normSymbol(symbol);
  if (!sym) {
    console.warn('[LeveragePrefs] saveMarginTypeForSymbol called with empty symbol – skipping');
    return;
  }
  const finalMarginType: MarginType = (marginType === 'cross' && !supportsCross) ? 'isolated' : marginType;
  const prefs = (await loadLeveragePrefs(ownerId)) ?? {};
  prefs.bySymbol = { ...(prefs.bySymbol ?? {}) };
  prefs.bySymbol[sym] = { ...(prefs.bySymbol[sym] ?? {}), marginType: finalMarginType };
  prefs.lastMarginType = finalMarginType;
  await saveLeveragePrefs(ownerId, prefs);
  console.log('[LeveragePrefs] saveMarginTypeForSymbol:', {
    ownerId: ownerId?.slice(0, 10),
    symbol: sym,
    marginType,
    finalMarginType,
  });
}

/**
 * Reset all leverage preferences for a user (both per-asset and global fallback).
 */
export async function resetAllLeveragePrefs(ownerId: string | null | undefined) {
  await saveLeveragePrefs(ownerId, {});
}

/**
 * Get a summary of current GLOBAL preferences (fallback values). Used for debug/display.
 */
export async function getLeveragePrefsSummary(ownerId: string | null | undefined): Promise<{
  lastLeverage: number;
  lastMarginType: MarginType;
}> {
  const prefs = await loadLeveragePrefs(ownerId);
  return {
    lastLeverage: prefs?.lastLeverage ?? DEFAULT_LEVERAGE,
    lastMarginType: prefs?.lastMarginType ?? 'isolated',
  };
}

// Legacy exports for compatibility - can be removed later
export const isHighLeverageSaved = async () => false;
