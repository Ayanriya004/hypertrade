/**
 * Stage 1 — Bank tab visible, KYC not launched yet (SOON badge + waitlist).
 * Set false for Stage 2 (KYC live) or Stage 3 (maintenance pause).
 */
export const BANK_KYC_PAUSED = true;

/**
 * Stage 3 — Banking already shipped (Play Store, etc.) but temporarily closed.
 * Nav shows PAUSED (not SOON). Guest page gets a maintenance banner.
 * Blocks new KYC. Does not hide funds UI for already-live banking
 * (`BANKING_FUNDS_UI_ENABLED` still follows `BANK_KYC_PAUSED` only).
 *
 * Wins over SOON if both are true. Set true + `BANK_KYC_PAUSED=false` for
 * a launched-then-paused product.
 */
export const BANK_SERVICE_PAUSED = true;

/** Block Start KYC — coming-soon waitlist or maintenance. */
export const BANK_KYC_ENTRY_BLOCKED = BANK_KYC_PAUSED || BANK_SERVICE_PAUSED;

export type BankNavBadgeKind = 'soon' | 'paused' | null;

export function getBankNavBadgeKind(): BankNavBadgeKind {
  if (BANK_SERVICE_PAUSED) return 'paused';
  if (BANK_KYC_PAUSED) return 'soon';
  return null;
}

/**
 * TEMP: UR paused fiat → USDC (digital) cash-out. Bank-transfer withdraw stays live.
 * Set to false when UR re-enables onramp-with-permit / digital withdraw.
 */
export const BANK_DIGITAL_WITHDRAW_PAUSED = true;
