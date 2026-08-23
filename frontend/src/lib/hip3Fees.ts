/**
 * Hyperliquid protocol fee math (builder fee is NOT included).
 *
 * Spec:
 * https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees
 * https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/hip-3-deployer-actions
 *
 * Perp HIP-3:
 *   hip3Scale = scale < 1 ? scale + 1 : scale * 2
 *   growthModeScale = growthMode ? 0.1 : 1
 *   rate = userFeeRate * hip3Scale * growthModeScale * (1 - referralDiscount)
 *
 * `deployerFeeScale` / `growthMode` come from per-asset `meta.universe` entries.
 */

export type GrowthModeInput = boolean | string | null | undefined;

/** HL returns `"enabled"` (string) on meta; treat that as on. */
export function isGrowthModeEnabled(value: GrowthModeInput): boolean {
  if (value === true) return true;
  if (value === false || value == null) return false;
  const s = String(value).trim().toLowerCase();
  return s === 'enabled' || s === 'true' || s === '1';
}

export function parseDeployerFeeScale(
  value: number | string | null | undefined,
  fallback = 1,
): number {
  if (value === null || value === undefined || value === '') return fallback;
  const n = typeof value === 'number' ? value : parseFloat(String(value));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * HIP-3 protocol multiplier from deployer fee scale.
 * scale 1 → 2; scale 0.5 → 1.5; scale 0 → 1; scale 3 → 6.
 */
export function hip3ScaleFromDeployerFeeScale(deployerFeeScale: number): number {
  if (!Number.isFinite(deployerFeeScale) || deployerFeeScale < 0) return 2;
  return deployerFeeScale < 1 ? deployerFeeScale + 1 : deployerFeeScale * 2;
}

export function growthModeScaleFromFlag(growthMode: GrowthModeInput): number {
  return isGrowthModeEnabled(growthMode) ? 0.1 : 1;
}

export type ProtocolFeeRatesInput = {
  /** Decimal from `userFees` (e.g. 0.00045). */
  takerRate: number;
  makerRate: number;
  /** 0..1 from `userFees.activeReferralDiscount`. */
  activeReferralDiscount?: number;
  kind: 'perp' | 'spot';
  /** Spot stable pairs get 0.2× protocol fees. */
  isStablePair?: boolean;
  isHip3?: boolean;
  deployerFeeScale?: number | string | null;
  growthMode?: GrowthModeInput;
};

export type ProtocolFeeRates = {
  /** Final protocol rates (decimal). Builder fee not included. */
  takerRate: number;
  makerRate: number;
  hip3Scale: number;
  growthModeScale: number;
  deployerFeeScale: number;
  growthMode: boolean;
};

/**
 * Apply HL fee formula for display / estimates.
 * Positive maker fees use the same HIP-3 × growth scaling as takers.
 * (Maker rebate branch for negative maker rates is unused for our current tiers.)
 */
export function computeProtocolFeeRates(input: ProtocolFeeRatesInput): ProtocolFeeRates {
  const referral = clamp01(input.activeReferralDiscount ?? 0);
  const stableScale = input.kind === 'spot' && input.isStablePair ? 0.2 : 1;

  const deployerFeeScale =
    input.isHip3 && input.kind === 'perp'
      ? parseDeployerFeeScale(input.deployerFeeScale, 1)
      : 1;
  const growthMode =
    input.isHip3 && input.kind === 'perp' ? isGrowthModeEnabled(input.growthMode) : false;
  const hip3Scale =
    input.isHip3 && input.kind === 'perp' ? hip3ScaleFromDeployerFeeScale(deployerFeeScale) : 1;
  const growthModeScale = growthMode ? 0.1 : 1;

  const scale = stableScale * hip3Scale * growthModeScale * (1 - referral);

  const baseTaker = Number.isFinite(input.takerRate) ? input.takerRate : 0;
  const baseMaker = Number.isFinite(input.makerRate) ? input.makerRate : 0;

  // Match HL docs: positive maker fees get HIP-3/growth/referral scaling;
  // negative maker rebates are not scaled the same way (we pass through).
  const takerRate = baseTaker * scale;
  const makerRate = baseMaker > 0 ? baseMaker * scale : baseMaker;

  return {
    takerRate,
    makerRate,
    hip3Scale,
    growthModeScale,
    deployerFeeScale,
    growthMode,
  };
}

/** Format a decimal rate as a percent string for UI tables. */
export function formatFeePercent(decimalRate: number, digits = 3): string {
  if (!Number.isFinite(decimalRate)) return '--';
  return `${(decimalRate * 100).toFixed(digits)}%`;
}

/** HL base-tier defaults when `userFees` is unavailable. */
export const DEFAULT_PERP_TAKER_RATE = 0.00045;
export const DEFAULT_PERP_MAKER_RATE = 0.00015;
export const DEFAULT_SPOT_TAKER_RATE = 0.0007;
export const DEFAULT_SPOT_MAKER_RATE = 0.0004;

/** Prefer live userFees; fall back to HL base tier when missing/zero. */
export function resolveBaseFeeRate(
  live: number,
  fallback: number,
): number {
  return Number.isFinite(live) && live > 0 ? live : fallback;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}
