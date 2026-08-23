import type { Asset } from './api';
import { SPOT_TOGGLE_WHITELIST } from './spotToggleWhitelist';

/** Search row augmented with explicit perp vs spot destination. */
export type AssetSearchRow = Asset & {
  searchMarket: 'perp' | 'spot';
  searchRowKey: string;
};

export function spotToggleBase(asset: Asset): string {
  const raw = String(asset.symbol ?? asset.coin ?? '').toUpperCase();
  return raw.includes(':') ? raw.split(':').pop()!.trim() : raw;
}

/**
 * Build search rows: per optional second spot destination for curated dual-listed
 * names, plus a single Spot row for `isSpotOnly` assets (e.g. USDT).
 */
export function expandAssetSearchRows(
  sorted: Asset[],
  options?: { allowSpot?: boolean },
): AssetSearchRow[] {
  const allowSpot = options?.allowSpot !== false;
  const out: AssetSearchRow[] = [];
  for (const a of sorted) {
    if (allowSpot && a.isSpotOnly === true) {
      out.push({
        ...a,
        searchMarket: 'spot',
        searchRowKey: `${a.coin}|spot`,
      });
      continue;
    }
    out.push({ ...a, searchMarket: 'perp', searchRowKey: `${a.coin}|perp` });
    if (
      allowSpot &&
      a.category === 'crypto' &&
      a.hasSpot === true &&
      SPOT_TOGGLE_WHITELIST.has(spotToggleBase(a))
    ) {
      out.push({ ...a, searchMarket: 'spot', searchRowKey: `${a.coin}|spot` });
    }
  }
  return out;
}
