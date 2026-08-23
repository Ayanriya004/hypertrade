/**
 * Tier-3 neobank UI gate.
 *
 * Default is **off** so new forks/builders ship trading-only until they opt in.
 * HyperTrade (and any fork with a UR partner) must set:
 *   EXPO_PUBLIC_ENABLE_BANKING=true
 *
 * Set `false` / `0` / `off` to hide Bank surfaces while leaving UR/banking code
 * in the tree for later partner enablement.
 *
 * Rebuild the Expo client after changing EXPO_PUBLIC_* (inlined at build time).
 *
 * See docs/FORKING.md · docs/BANKING_UR.md
 */

import { BANK_KYC_PAUSED } from './bankKycPause';

function parseEnvBool(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw == null || String(raw).trim() === '') return defaultValue;
  const s = String(raw).trim().toLowerCase();
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  return defaultValue;
}

export const BANKING_ENABLED = parseEnvBool(
  process.env.EXPO_PUBLIC_ENABLE_BANKING,
  false,
);

/**
 * Bank rail / cards on Profile + DepositPanel only.
 *
 * When KYC is paused (Stage 1 SOON), users can't apply — hide the bank
 * balance card and related deposit CTAs so the funds UI matches banking-off
 * layout. Stage 3 maintenance (`BANK_SERVICE_PAUSED`) does **not** hide this
 * — already-live users keep funds rails. Does **not** gate `/bank-guest`,
 * bottom nav, fees copy, or other `BANKING_ENABLED` surfaces.
 */
export const BANKING_FUNDS_UI_ENABLED = BANKING_ENABLED && !BANK_KYC_PAUSED;
