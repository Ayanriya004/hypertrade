/** Bank / UR FAQ topic ids — keep in sync with `bankFaq.topics.*` locale keys. */
export const BANK_FAQ_TOPIC_IDS = [
  'kyc',
  'kycDocuments',
  'topUp',
  'regions',
  'fees',
  'accountLimits',
  'iban',
  'withdrawals',
  'cardFree',
  'cardSpendCurrency',
  'physicalCard',
  'cardSpending',
  'mobileWallets',
  'getHelp',
] as const;

export type BankFaqTopicId = (typeof BANK_FAQ_TOPIC_IDS)[number];

export function isBankFaqTopicId(value: string): value is BankFaqTopicId {
  return (BANK_FAQ_TOPIC_IDS as readonly string[]).includes(value);
}
