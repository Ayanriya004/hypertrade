/**
 * HIP-3 coins agents may NOT manage — no meaningful CoinGlass/options/
 * underlier stack (or deferred categories). Keep in sync with
 * `AI_AGENT_HIP3_EXCLUDED_COINS` in `backend/ai_agents.py`.
 *
 * Coin part only (e.g. `PURRDAT` for `xyz:PURRDAT`). DRAM + EWY are
 * intentionally kept (real US ETFs with options). GOLD + SILVER are
 * kept (Massive GLD/SLV proxy options + DXY/EMA metals stack).
 *
 * Pre-IPO (`isPreIpo`, e.g. `io:ANTH`) is also blocked in the picker even
 * if a coin is missing here.
 */
export const AI_AGENT_HIP3_EXCLUDED_COINS: ReadonlySet<string> = new Set([
  // Stocks — no usable US underlier / options identity
  'PURRDAT',
  'SMSN',
  'BOT',
  'CXMT',
  'UNITREE',
  // EntropyIO pre-IPO (market-cap quote, no listed options underlier)
  'ANTH',
  // Forex — deferred
  'EUR',
  'JPY',
  // Commodities — deferred (GOLD/SILVER enabled via GLD/SLV options proxies)
  'PLATINUM',
  'PALLADIUM',
  'COPPER',
  'CL',
  'BZ',
  'BRENTOIL',
  'NATGAS',
  'URNM',
  'GOLDSPOT',
  // Synthetic HL index names (not SPY/QQQ underliers)
  'XYZ100',
  'SP500',
]);

/**
 * HIP-3 dexs the worker will trade. Protocol identity is `{dex}:{COIN}` for
 * any deployer. Catalog + exclude + `isPreIpo` still gate which tickers
 * appear; adding a listed `io:*` row to `ASSET_METADATA` is enough.
 */
export const AI_AGENT_SUPPORTED_HIP3_DEXES: ReadonlySet<string> = new Set(['xyz', 'io']);

/** True when a HIP-3 (or bare) coin is blocked for AI agents. */
export function isAiAgentHip3Excluded(coinOrSymbol: string): boolean {
  const raw = String(coinOrSymbol ?? '').trim().toUpperCase();
  if (!raw) return false;
  const coin = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw;
  return AI_AGENT_HIP3_EXCLUDED_COINS.has(coin);
}
