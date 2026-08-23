import type { UrCountry } from './urSupportedCountries';

export type BankApplyMode = 'kyc' | 'bank_waitlist' | 'select_region';

/**
 * Which primary action to show on bank apply / pre-KYC screens.
 *
 * The residence picker lists supported regions only.
 *   - A supported country selected → `kyc` (Start KYC).
 *   - User explicitly picked "My country isn't listed" → `bank_waitlist`
 *     (generic notify CTA + email capture).
 *   - Nothing chosen yet → `select_region` (prompt the user to pick first so
 *     they can see whether their region is supported, rather than defaulting
 *     to a misleading "not available, notify me" state).
 */
export function resolveBankApplyMode(
  selectedCountry: UrCountry | null,
  notListedChosen = false,
): BankApplyMode {
  if (selectedCountry) return 'kyc';
  if (notListedChosen) return 'bank_waitlist';
  return 'select_region';
}
