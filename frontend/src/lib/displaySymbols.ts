import { hip3DisplaySymbol } from './hip3Dexes';

// Overrides applied to the raw HL/exchange symbol when rendering.
//
//   • Perp aliases: `CL → OIL`, `XYZ100 → NDX100` — HL keeps its internal
//     bloomberg-style coin name for stocks / indices / commodities, but we
//     show the marketing symbol everywhere.
//   • Spot wrapped tokens: HL bridges external L1 assets under a `U` prefix
//     (`UBTC`, `UETH`, `USOL`, `UZEC`, `UENA`, `UMON`, `UXPL`, `UAAVE`, …).
//     From a user POV these represent the L1 asset on HL Core, so we
//     display them as their L1 symbol in positions / orders / history.
//     Native-to-HL tokens (HYPE, USDT, USDH, PURR, …) are not in
//     this map and pass through unchanged.
//   • Tether gold spot (XAUT) was displayed as GOLDSPOT — mapping commented
//     out while that market is hidden from browse (see hiddenMarkets.ts).
//     Re-enable with spot list + AssetLogo when liquidity returns by
//     restoring the entries inside DISPLAY_SYMBOL_OVERRIDES, e.g.:
//       XAUT: 'GOLDSPOT',
//       XAUT0: 'GOLDSPOT',
const DISPLAY_SYMBOL_OVERRIDES: Record<string, string> = {
  CL: 'OIL',
  XYZ100: 'NDX100',
  // HL-bridged L1 assets on spot
  UBTC: 'BTC',
  UETH: 'ETH',
  USOL: 'SOL',
  UZEC: 'ZEC',
  UENA: 'ENA',
  UMON: 'MON',
  UXPL: 'XPL',
  UAAVE: 'AAVE',
};

export function getDisplaySymbolOverride(symbol: string | null | undefined): string | undefined {
  const raw = String(symbol ?? '').trim().toUpperCase();
  if (!raw) return undefined;
  return DISPLAY_SYMBOL_OVERRIDES[raw];
}

export function formatDisplaySymbol(
  coin: string | null | undefined,
  spotSymbolMap?: { bySymbol?: Record<string, { baseCoin?: string }> } | null,
): string {
  const rawCoin = String(coin ?? '');
  if (!rawCoin) return rawCoin;

  if (rawCoin.startsWith('@')) {
    const base = spotSymbolMap?.bySymbol?.[rawCoin]?.baseCoin;
    return getDisplaySymbolOverride(base) ?? base ?? rawCoin;
  }

  const stripped = rawCoin.includes(':') ? hip3DisplaySymbol(rawCoin) : rawCoin;
  return getDisplaySymbolOverride(stripped) ?? stripped;
}

/**
 * Pick the route coin for `/asset/[coin]`. HIP-3 (`xyz:XYZ100`) passes
 * through unchanged — backend handles those. HL spot positions carry a raw
 * `@N` symbol or the HL-bridged base name (e.g. `USOL`, `UBTC`) that the
 * backend's asset-detail endpoint does NOT resolve; map both to the display
 * symbol (`@156`/`USOL` → `SOL`) so the asset page can fetch details via
 * the canonical crypto coin instead of 404'ing.
 */
export function getDisplayAssetRouteSymbol(
  coin: string | null | undefined,
  spotSymbolMap?: { bySymbol?: Record<string, { baseCoin?: string }> } | null,
): string {
  const rawCoin = String(coin ?? '');
  if (!rawCoin) return rawCoin;
  if (rawCoin.startsWith('@')) {
    const display = formatDisplaySymbol(rawCoin, spotSymbolMap);
    return display || rawCoin;
  }
  // Plain token names (e.g. `USOL`) can also come through when a spot
  // position falls back to its base coin. Apply the same override map so
  // the asset page lands on a backend-resolvable coin.
  const override = getDisplaySymbolOverride(rawCoin);
  return override ?? rawCoin;
}
