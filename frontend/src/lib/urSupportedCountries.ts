/** Banking-partner residence list — aligned with official supported territories. */
export interface UrCountry {
  code: string;
  name: string;
  nativeName?: string;
}

/** ISO 3166-1 alpha-2 codes where banking onboarding is available. */
export const SUPPORTED_UR_COUNTRY_CODES = new Set([
  'AX', 'AT', 'AU', 'BE', 'BG', 'BR', 'CA', 'CH', 'CN', 'CY', 'CZ', 'DE', 'DK',
  'EE', 'ES', 'FI', 'FO', 'FR', 'GB', 'GR', 'HK', 'HR', 'HU', 'IE', 'IS', 'IT',
  'JP', 'KR', 'LI', 'LT', 'LU', 'LV', 'MY', 'NL', 'NO', 'NZ', 'PL', 'PT', 'RE',
  'RO', 'SE', 'SG', 'SI', 'SJ', 'SK', 'TW', 'AE',
]);

const RAW_COUNTRIES: UrCountry[] = [
  { code: 'AE', name: 'United Arab Emirates' },
  { code: 'AX', name: 'Åland Islands' },
  { code: 'AR', name: 'Argentina' },
  { code: 'AU', name: 'Australia' },
  { code: 'AT', name: 'Austria', nativeName: 'Österreich' },
  { code: 'BE', name: 'Belgium', nativeName: 'België' },
  { code: 'BO', name: 'Bolivia', nativeName: 'Estado Plurinacional' },
  { code: 'BR', name: 'Brazil', nativeName: 'Brasil' },
  { code: 'BG', name: 'Bulgaria', nativeName: 'България' },
  { code: 'CA', name: 'Canada' },
  { code: 'CH', name: 'Switzerland', nativeName: 'Schweiz' },
  { code: 'CN', name: 'China', nativeName: '中国' },
  { code: 'CY', name: 'Cyprus' },
  { code: 'CZ', name: 'Czechia', nativeName: 'Česko' },
  { code: 'DE', name: 'Germany', nativeName: 'Deutschland' },
  { code: 'DK', name: 'Denmark', nativeName: 'Danmark' },
  { code: 'EE', name: 'Estonia', nativeName: 'Eesti' },
  { code: 'ES', name: 'Spain', nativeName: 'España' },
  { code: 'FI', name: 'Finland', nativeName: 'Suomi' },
  { code: 'FO', name: 'Faroe Islands', nativeName: 'Føroyar' },
  { code: 'FR', name: 'France' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'GR', name: 'Greece', nativeName: 'Ελλάδα' },
  { code: 'HK', name: 'Hong Kong', nativeName: '香港' },
  { code: 'HR', name: 'Croatia', nativeName: 'Hrvatska' },
  { code: 'HU', name: 'Hungary', nativeName: 'Magyarország' },
  { code: 'IE', name: 'Ireland', nativeName: 'Éire' },
  { code: 'IN', name: 'India', nativeName: 'भारत' },
  { code: 'IR', name: 'Iran' },
  { code: 'IS', name: 'Iceland', nativeName: 'Ísland' },
  { code: 'IT', name: 'Italy', nativeName: 'Italia' },
  { code: 'JP', name: 'Japan', nativeName: '日本' },
  { code: 'KP', name: 'North Korea' },
  { code: 'KR', name: 'South Korea', nativeName: '대한민국' },
  { code: 'LI', name: 'Liechtenstein' },
  { code: 'LT', name: 'Lithuania', nativeName: 'Lietuva' },
  { code: 'LU', name: 'Luxembourg' },
  { code: 'LV', name: 'Latvia', nativeName: 'Latvija' },
  { code: 'MY', name: 'Malaysia' },
  { code: 'MT', name: 'Malta' },
  { code: 'MX', name: 'Mexico', nativeName: 'México' },
  { code: 'NL', name: 'Netherlands', nativeName: 'Nederland' },
  { code: 'NO', name: 'Norway', nativeName: 'Norge' },
  { code: 'NZ', name: 'New Zealand' },
  { code: 'PL', name: 'Poland', nativeName: 'Polska' },
  { code: 'PT', name: 'Portugal' },
  { code: 'RE', name: 'Réunion' },
  { code: 'RO', name: 'Romania', nativeName: 'România' },
  { code: 'RU', name: 'Russia', nativeName: 'Россия' },
  { code: 'SE', name: 'Sweden', nativeName: 'Sverige' },
  { code: 'SG', name: 'Singapore' },
  { code: 'SI', name: 'Slovenia', nativeName: 'Slovenija' },
  { code: 'SJ', name: 'Svalbard and Jan Mayen' },
  { code: 'SK', name: 'Slovakia', nativeName: 'Slovensko' },
  { code: 'SY', name: 'Syria' },
  { code: 'TR', name: 'Turkey', nativeName: 'Türkiye' },
  { code: 'TW', name: 'Taiwan', nativeName: '台灣' },
  { code: 'UA', name: 'Ukraine', nativeName: 'Україна' },
  { code: 'US', name: 'United States' },
  { code: 'ZA', name: 'South Africa' },
];

export const UR_COUNTRIES: UrCountry[] = [...RAW_COUNTRIES]
  .filter((c) => SUPPORTED_UR_COUNTRY_CODES.has(c.code))
  .sort((a, b) => a.name.localeCompare(b.name));

/** Same as UR_COUNTRIES — KYC residence picker lists supported regions only. */
export const KYC_RESIDENCE_COUNTRIES = UR_COUNTRIES;

export type UrCountrySection = { title: string; data: UrCountry[] };

export function countryFlagEmoji(code: string): string {
  const c = code.toUpperCase();
  if (c.length !== 2) return '🌐';
  return String.fromCodePoint(...[...c].map((ch) => 127397 + ch.charCodeAt(0)));
}

export function isUrCountrySupported(code: string): boolean {
  return SUPPORTED_UR_COUNTRY_CODES.has(code.toUpperCase());
}

export function formatCountryLabel(country: UrCountry): string {
  return country.nativeName ? `${country.name} (${country.nativeName})` : country.name;
}

export function searchUrCountries(query: string): UrCountry[] {
  const q = query.trim().toLowerCase();
  if (!q) return UR_COUNTRIES;
  return UR_COUNTRIES.filter(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      c.code.toLowerCase().includes(q) ||
      (c.nativeName?.toLowerCase().includes(q) ?? false),
  );
}

export function groupUrCountriesByLetter(countries: UrCountry[]): UrCountrySection[] {
  const map = new Map<string, UrCountry[]>();
  for (const country of countries) {
    const letter = country.name.charAt(0).toUpperCase();
    const bucket = map.get(letter) ?? [];
    bucket.push(country);
    map.set(letter, bucket);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([title, data]) => ({ title, data }));
}

/** Pre-grouped for the residence picker (empty search). */
export const UR_COUNTRY_SECTIONS: UrCountrySection[] =
  groupUrCountriesByLetter(UR_COUNTRIES);

export type UrCountryListRow =
  | { type: 'header'; key: string; letter: string }
  | { type: 'country'; key: string; country: UrCountry };

export function sectionsToFlatRows(sections: UrCountrySection[]): UrCountryListRow[] {
  const rows: UrCountryListRow[] = [];
  for (const section of sections) {
    rows.push({ type: 'header', key: `h-${section.title}`, letter: section.title });
    for (const country of section.data) {
      rows.push({ type: 'country', key: country.code, country });
    }
  }
  return rows;
}

/** Pre-flattened for the residence picker (empty search). */
export const UR_COUNTRY_LIST_ROWS: UrCountryListRow[] =
  sectionsToFlatRows(UR_COUNTRY_SECTIONS);
