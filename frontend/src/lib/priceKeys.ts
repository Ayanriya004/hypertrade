import {
  isHip3DexName,
  normalizeHip3Coin,
  splitHip3Symbol,
} from './hip3Dexes';

export type PriceEntry = { price?: string | number | null } | string | number | null | undefined;

export function normalizeDexPriceKey(coin: string, dex?: string | null) {
  return normalizeHip3Coin(coin, dex);
}

export function getPriceLookupKeys(input: {
  coin?: string | null;
  symbol?: string | null;
  isHip3?: boolean | null;
  dex?: string | null;
}) {
  const coin = input.coin ? String(input.coin) : '';
  const symbol = input.symbol ? String(input.symbol) : '';
  const parsedCoin = coin ? splitHip3Symbol(coin, input.dex) : null;
  const dex = input.dex || parsedCoin?.dex || undefined;
  const hip3 = input.isHip3 === true || coin.includes(':') || (!!dex && isHip3DexName(dex));
  const keys: string[] = [];
  const push = (v?: string | null) => {
    if (v && !keys.includes(v)) keys.push(v);
  };

  if (hip3) {
    if (coin) push(normalizeHip3Coin(coin, dex));
    if (symbol) push(normalizeHip3Coin(symbol, dex));
    return keys;
  }

  push(coin);
  push(symbol);
  return keys;
}

export function readPriceEntry(entry: PriceEntry) {
  if (entry == null) return undefined;
  if (typeof entry === 'object') {
    const px = entry.price;
    return px == null ? undefined : String(px);
  }
  return String(entry);
}

export function pickPrice<T extends Record<string, PriceEntry> | null | undefined>(
  prices: T,
  input: Parameters<typeof getPriceLookupKeys>[0],
) {
  if (!prices) return undefined;
  for (const key of getPriceLookupKeys(input)) {
    const value = readPriceEntry(prices[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}
