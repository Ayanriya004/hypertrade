/**
 * Asset-class tagging for brain prompts.
 *
 * HIP-3 map is kept in lockstep with backend `ASSET_METADATA`
 * (`backend/server.py`) — only symbols we actually list in the app.
 * Categories: server `stock` → equity. Never used for margin-mode
 * decisions — those stay on live HL `onlyIsolated` / meta.
 */

export type AssetClass = 'crypto' | 'equity' | 'commodity' | 'forex' | 'index';

/** HIP-3 base coin (no dex prefix) → class. Mirrors ASSET_METADATA keys. */
const HIP3_CLASS: Record<string, AssetClass> = {
  // Stocks (server category: stock)
  TSLA: 'equity',
  NVDA: 'equity',
  AAPL: 'equity',
  GOOGL: 'equity',
  AMZN: 'equity',
  MSFT: 'equity',
  META: 'equity',
  INTC: 'equity',
  AMD: 'equity',
  COIN: 'equity',
  HOOD: 'equity',
  MSTR: 'equity',
  PURRDAT: 'equity',
  PLTR: 'equity',
  ORCL: 'equity',
  BOT: 'equity',
  SKHY: 'equity',
  RIVN: 'equity',
  MU: 'equity',
  BABA: 'equity',
  SNDK: 'equity',
  CRCL: 'equity',
  CRWV: 'equity',
  SPCX: 'equity',
  CBRS: 'equity',
  IBM: 'equity',
  DELL: 'equity',
  AVGO: 'equity',
  MRVL: 'equity',
  GME: 'equity',
  NFLX: 'equity',
  TSM: 'equity',
  SMSN: 'equity',
  CXMT: 'equity',
  UNITREE: 'equity',
  LITE: 'equity',
  MRNA: 'equity',
  LLY: 'equity',
  // Forex
  EUR: 'forex',
  JPY: 'forex',
  // Commodities
  GOLD: 'commodity',
  SILVER: 'commodity',
  PLATINUM: 'commodity',
  PALLADIUM: 'commodity',
  COPPER: 'commodity',
  CL: 'commodity',
  BZ: 'commodity',
  /** HL lists Brent as BRENTOIL; ASSET_METADATA key is BZ. */
  BRENTOIL: 'commodity',
  NATGAS: 'commodity',
  URNM: 'commodity',
  // Indices / ETFs
  XYZ100: 'index',
  SP500: 'index',
  EWY: 'index',
  DRAM: 'index',
};

export function isHip3Symbol(symbol: string): boolean {
  return String(symbol ?? '').includes(':');
}

export function coinPart(symbol: string): string {
  const s = String(symbol ?? '').toUpperCase();
  const i = s.indexOf(':');
  return i >= 0 ? s.slice(i + 1) : s;
}

export function assetClassOf(symbol: string): AssetClass {
  if (!isHip3Symbol(symbol)) return 'crypto';
  // Unknown HIP-3 (not in ASSET_METADATA) — equity is the safest default
  // for session/earnings gating; listing gate should prevent this in practice.
  return HIP3_CLASS[coinPart(symbol)] ?? 'equity';
}

export function isCryptoAsset(symbol: string): boolean {
  return assetClassOf(symbol) === 'crypto';
}

export function classLabel(c: AssetClass): string {
  switch (c) {
    case 'equity':
      return 'equity / single-stock';
    case 'commodity':
      return 'commodity';
    case 'forex':
      return 'FX';
    case 'index':
      return 'index / ETF';
    default:
      return 'crypto';
  }
}
