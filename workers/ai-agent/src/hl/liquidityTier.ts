/**
 * Shared symbol liquidity tiers for slippage bands and risk-parity sizing.
 * Catalog aligned with app CRYPTO_METADATA (`backend/server.py`).
 */

export type LiquidityTier = 'major' | 'mid' | 'thin';

const MAJORS = new Set(['BTC', 'ETH']);

/**
 * Mid-liquidity names from our CRYPTO_METADATA catalog.
 * Everything else (VVV, JTO, ONDO, LIT, ENA, …) is thin.
 * Spot-only (KNTQ/USDT) omitted.
 */
const MID_LIQUID = new Set([
  'SOL',
  'XRP',
  'HYPE',
  'BNB',
  'ZEC',
  'XMR',
  'LINK',
  'GRAM',
  'AAVE',
  'NEAR',
  'ARB',
  'SUI',
  'UNI',
  'WLD',
  'TRX',
  'LTC',
  'BCH',
  'ADA',
  'AVAX',
  'APT',
]);

export function liquidityTier(symbol: string): LiquidityTier {
  const sym = symbol.toUpperCase();
  if (MAJORS.has(sym)) return 'major';
  if (MID_LIQUID.has(sym)) return 'mid';
  return 'thin';
}

/** BTC/ETH + mid-liquid catalog — healthier books / liq depth. */
export function isLiquidSymbol(symbol: string): boolean {
  return liquidityTier(symbol) !== 'thin';
}
