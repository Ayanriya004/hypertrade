/** ISO 3166-1 alpha-2 (or EU) codes for react-native-svg-circle-country-flags. */
export const CURRENCY_COUNTRY_ISO: Record<string, string> = {
  USD: 'US',
  EUR: 'EU',
  CHF: 'CH',
  GBP: 'GB',
  JPY: 'JP',
  CNY: 'CN',
  CNH: 'CN',
  SGD: 'SG',
  HKD: 'HK',
  AUD: 'AU',
  CAD: 'CA',
};

export function currencyToCountryIso(currencyCode: string): string | undefined {
  return CURRENCY_COUNTRY_ISO[currencyCode.toUpperCase()];
}

/** Package export keys: `us` → `Us`, `EU` → `Eu`. */
export function countryIsoToFlagKey(iso: string): string {
  const c = iso.trim();
  if (c.length === 2) {
    return c.charAt(0).toUpperCase() + c.charAt(1).toLowerCase();
  }
  return c.charAt(0).toUpperCase() + c.slice(1);
}
