export type PriceEntry = { price?: string | number | null } | string | number | null | undefined;

const KNOWN_HIP3_DEXES = new Set(['xyz', 'trade.xyz']);

function splitHip3Symbol(value: string, fallbackDex = 'xyz') {
  if (!value.includes(':')) {
    return { dex: fallbackDex, base: value };
  }
  const [left, right] = value.split(':');
  const leftNorm = left.toLowerCase();
  const rightNorm = right.toLowerCase();
  if (KNOWN_HIP3_DEXES.has(leftNorm)) {
    return { dex: left, base: right };
  }
  if (KNOWN_HIP3_DEXES.has(rightNorm)) {
    return { dex: right, base: left };
  }
  return { dex: fallbackDex, base: right || left };
}

export function normalizeDexPriceKey(coin: string, dex?: string | null) {
  const fallbackDex = dex || 'xyz';
  const parsed = splitHip3Symbol(coin, fallbackDex);
  return `${parsed.dex}:${parsed.base}`;
}

export function getPriceLookupKeys(input: {
  coin?: string | null;
  symbol?: string | null;
  isHip3?: boolean | null;
  dex?: string | null;
}) {
  const coin = input.coin ? String(input.coin) : '';
  const symbol = input.symbol ? String(input.symbol) : '';
  const parsedCoin = coin ? splitHip3Symbol(coin, input.dex || 'xyz') : null;
  const dex = input.dex || parsedCoin?.dex || 'xyz';
  const hip3 = input.isHip3 === true || coin.includes(':');
  const keys: string[] = [];
  const push = (v?: string | null) => {
    if (v && !keys.includes(v)) keys.push(v);
  };

  if (hip3) {
    if (coin) push(normalizeDexPriceKey(coin, dex));
    if (symbol) push(normalizeDexPriceKey(symbol, dex));
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
