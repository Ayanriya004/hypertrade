import type { Asset } from './api';

/**
 * Tether Gold spot (app routes as GOLDSPOT; HL core may use XAUT / XAUT0).
 * Kept out of browse/search/toggles while the book is too thin — plug back by
 * removing `.filter(!isHiddenLowLiquidityGoldSpotAsset)` call sites and
 * uncommenting GOLDSPOT in `CUSTOM_MARKET_ORDER`, `spotToggleWhitelist`,
 * `displaySymbols`, and `AssetLogo`.
 *
 * Perp / HIP-3 gold (`GOLD`, `xyz:GOLD`, etc.) must stay tradeable — never add
 * plain `GOLD` to this set.
 */
const HIDDEN_GOLDSPOT_SYMBOLS = new Set(['GOLDSPOT', 'XAUT', 'XAUT0']);

export function isHiddenLowLiquidityGoldSpotAsset(asset: Pick<Asset, 'symbol' | 'coin'>): boolean {
  const sym = String(asset.symbol ?? '').toUpperCase();
  const coin = String(asset.coin ?? '').toUpperCase();
  for (const raw of [sym, coin]) {
    if (!raw) continue;
    if (HIDDEN_GOLDSPOT_SYMBOLS.has(raw)) return true;
    const base = raw.includes(':') ? raw.split(':').pop()! : raw;
    if (HIDDEN_GOLDSPOT_SYMBOLS.has(base)) return true;
  }
  return false;
}
