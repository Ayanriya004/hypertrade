/** Dev-only preview for the card View reveal UI (no UR card-display script). */
export function isCardRevealDevMockEnabled(): boolean {
  if (!__DEV__) return false;
  // Off by default — set EXPO_PUBLIC_MOCK_CARD_REVEAL=true to preview reveal UI locally.
  return process.env.EXPO_PUBLIC_MOCK_CARD_REVEAL === 'true';
}

export const MOCK_CARD_EXPIRY = '12/28';
export const MOCK_CARD_CVV = '123';

export function mockCardPan(last4?: string): string {
  const tail = (last4 ?? '9012').replace(/\D/g, '').slice(-4).padStart(4, '0');
  return `4532 1234 5678 ${tail}`;
}
