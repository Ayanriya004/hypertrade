// Symbols for which we allow the perp ↔ spot toggle to appear in
// `QuickTradeCard` and the `/trade/[coin]` page.
//
// This intentionally mirrors the `spot` array in `app/index.tsx`'s
// `CUSTOM_MARKET_ORDER`. Hyperliquid lists spot markets for many more
// coins than the ones we want users to trade as spot (most have very
// thin liquidity / poor orderbook depth, e.g. TAO, WLD). Gating the
// toggle on this whitelist keeps users on the deeper perp book for
// everything outside the curated set.
//
// If you add a coin to the spot tab on the homepage, remember to also
// add it here (and vice versa).
export const SPOT_TOGGLE_WHITELIST = new Set<string>([
  // 'GOLDSPOT', // XAUT — re-enable with index commodities + hiddenMarkets filter
  'BTC',
  'ETH',
  'HYPE',
  'SOL',
  'ZEC',
  'ENA',
  'MON',
  'XPL',
  'PUMP',
  'KNTQ',
  'USDT',
]);
