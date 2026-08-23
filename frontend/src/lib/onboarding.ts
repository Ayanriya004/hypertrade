import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE_URL } from './api';

const ONBOARDING_CACHE_KEY = 'hypertrade_onboarding_completed';

export async function fetchOnboardingAccountInfo(
  accessToken: string,
): Promise<{ created_at: string | null }> {
  try {
    const res = await fetch(`${API_BASE_URL}/onboarding/account-info`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return { created_at: null };
    const data = await res.json();
    return { created_at: typeof data.created_at === 'string' ? data.created_at : null };
  } catch {
    return { created_at: null };
  }
}

export async function fetchOnboardingStatus(accessToken: string): Promise<boolean> {
  try {
    const cached = await AsyncStorage.getItem(ONBOARDING_CACHE_KEY);
    if (cached === '1') return true;

    const res = await fetch(`${API_BASE_URL}/onboarding/status`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) return false;

    const data = await res.json();
    const completed = data.guide_completed === true;

    if (completed) {
      await AsyncStorage.setItem(ONBOARDING_CACHE_KEY, '1');
    }

    return completed;
  } catch {
    return false;
  }
}

export async function completeOnboarding(accessToken: string): Promise<void> {
  try {
    await AsyncStorage.setItem(ONBOARDING_CACHE_KEY, '1');

    await fetch(`${API_BASE_URL}/onboarding/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
    });
  } catch {
    // Local cache is already set — backend will be retried implicitly on next app open
  }
}

export async function resetOnboardingCache(): Promise<void> {
  try {
    await AsyncStorage.removeItem(ONBOARDING_CACHE_KEY);
  } catch { /* noop */ }
}

export async function isOnboardingCachedComplete(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(ONBOARDING_CACHE_KEY)) === '1';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Profile funds tour (/profile) — wallet deposit → trade → bank
// ---------------------------------------------------------------------------

export const PROFILE_GUIDE_STEP_COUNT = 3 as const;

export type ProfileGuideStep = 0 | 1 | 2 | 3;

export type ProfileGuideStepContent = {
  titleKey:
    | 'onboarding.depositStep'
    | 'onboarding.tradeStep'
    | 'onboarding.bankStep';
  descKey:
    | 'onboarding.depositDesc'
    | 'onboarding.tradeDesc'
    | 'onboarding.bankDesc';
};

export const PROFILE_GUIDE_STEPS: Record<1 | 2 | 3, ProfileGuideStepContent> = {
  1: { titleKey: 'onboarding.depositStep', descKey: 'onboarding.depositDesc' },
  2: { titleKey: 'onboarding.tradeStep', descKey: 'onboarding.tradeDesc' },
  3: { titleKey: 'onboarding.bankStep', descKey: 'onboarding.bankDesc' },
};

/** Bank step omitted when Tier-3 UI is off (`EXPO_PUBLIC_ENABLE_BANKING=false`). */
export function getProfileGuideStepCount(bankingEnabled: boolean): 2 | 3 {
  return bankingEnabled ? PROFILE_GUIDE_STEP_COUNT : 2;
}

export function isProfileGuideActive(
  step: ProfileGuideStep,
  maxStep: number = PROFILE_GUIDE_STEP_COUNT,
): step is 1 | 2 | 3 {
  return step >= 1 && step <= maxStep;
}

export function getProfileGuideStepContent(
  step: ProfileGuideStep,
  maxStep: number = PROFILE_GUIDE_STEP_COUNT,
): ProfileGuideStepContent | null {
  if (!isProfileGuideActive(step, maxStep)) return null;
  return PROFILE_GUIDE_STEPS[step];
}

// ---------------------------------------------------------------------------
// Asset page onboarding (independent from profile onboarding)
// ---------------------------------------------------------------------------

const ASSET_ONBOARDING_CACHE_KEY = 'hypertrade_asset_onboarding_completed';

export async function fetchAssetOnboardingStatus(accessToken: string): Promise<boolean> {
  try {
    const cached = await AsyncStorage.getItem(ASSET_ONBOARDING_CACHE_KEY);
    if (cached === '1') return true;

    const res = await fetch(`${API_BASE_URL}/onboarding/asset-status`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) return false;

    const data = await res.json();
    const completed = data.asset_guide_completed === true;

    if (completed) {
      await AsyncStorage.setItem(ASSET_ONBOARDING_CACHE_KEY, '1');
    }

    return completed;
  } catch {
    return false;
  }
}

export async function completeAssetOnboarding(accessToken: string): Promise<void> {
  try {
    await AsyncStorage.setItem(ASSET_ONBOARDING_CACHE_KEY, '1');

    await fetch(`${API_BASE_URL}/onboarding/complete-asset`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
    });
  } catch {
    // Local cache is already set
  }
}

export async function resetAssetOnboardingCache(): Promise<void> {
  try {
    await AsyncStorage.removeItem(ASSET_ONBOARDING_CACHE_KEY);
  } catch { /* noop */ }
}

export async function isAssetOnboardingCachedComplete(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(ASSET_ONBOARDING_CACHE_KEY)) === '1';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Bank / region / card waitlists → Supabase user_onboarding
// ---------------------------------------------------------------------------

export type OnboardingInterestKind = 'bank' | 'bank_region' | 'card';

export interface OnboardingInterests {
  bank_interest: boolean;
  bank_region_interest: boolean;
  bank_region_interest_country: string | null;
  card_interest: boolean;
}

const INTEREST_CACHE_PREFIX = 'hypertrade_interest_';

function interestCacheKey(kind: OnboardingInterestKind, countryCode?: string): string {
  if (kind === 'bank_region' && countryCode) {
    return `${INTEREST_CACHE_PREFIX}bank_region_${countryCode.toUpperCase()}`;
  }
  return `${INTEREST_CACHE_PREFIX}${kind}`;
}

function applyInterestCache(interests: OnboardingInterests): Promise<void> {
  const tasks: Promise<void>[] = [];
  if (interests.bank_interest) {
    tasks.push(AsyncStorage.setItem(interestCacheKey('bank'), '1'));
  }
  if (interests.bank_region_interest && interests.bank_region_interest_country) {
    tasks.push(
      AsyncStorage.setItem(
        interestCacheKey('bank_region', interests.bank_region_interest_country),
        '1',
      ),
    );
  }
  if (interests.card_interest) {
    tasks.push(AsyncStorage.setItem(interestCacheKey('card'), '1'));
  }
  return Promise.all(tasks).then(() => undefined);
}

export async function fetchOnboardingInterests(
  accessToken: string,
): Promise<OnboardingInterests> {
  const empty: OnboardingInterests = {
    bank_interest: false,
    bank_region_interest: false,
    bank_region_interest_country: null,
    card_interest: false,
  };
  try {
    const res = await fetch(`${API_BASE_URL}/onboarding/interests`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return empty;

    const data = await res.json();
    const interests: OnboardingInterests = {
      bank_interest: data.bank_interest === true,
      bank_region_interest: data.bank_region_interest === true,
      bank_region_interest_country: data.bank_region_interest_country ?? null,
      card_interest: data.card_interest === true,
    };
    await applyInterestCache(interests);
    return interests;
  } catch {
    return empty;
  }
}

export async function registerOnboardingInterest(
  accessToken: string,
  kind: OnboardingInterestKind,
  countryCode?: string,
): Promise<boolean> {
  try {
    let path: string;
    let body: string | undefined;

    if (kind === 'bank') {
      path = '/bank/interest';
    } else if (kind === 'bank_region') {
      if (!countryCode) return false;
      path = '/bank/region-interest';
      body = JSON.stringify({ country_code: countryCode.toUpperCase() });
    } else {
      path = '/card/interest';
    }

    const res = await fetch(`${API_BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body,
    });
    if (!res.ok) return false;

    await AsyncStorage.setItem(
      interestCacheKey(kind, countryCode),
      '1',
    );
    return true;
  } catch {
    return false;
  }
}

export async function isInterestCached(
  kind: OnboardingInterestKind,
  countryCode?: string,
): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(interestCacheKey(kind, countryCode))) === '1';
  } catch {
    return false;
  }
}

/** @deprecated Use registerOnboardingInterest(token, 'card') */
export async function registerCardInterest(accessToken: string): Promise<boolean> {
  return registerOnboardingInterest(accessToken, 'card');
}

/** @deprecated Use fetchOnboardingInterests */
export async function fetchCardInterestStatus(accessToken: string): Promise<boolean> {
  const interests = await fetchOnboardingInterests(accessToken);
  return interests.card_interest;
}

/** @deprecated Use isInterestCached('card') */
export async function isCardInterestCached(): Promise<boolean> {
  return isInterestCached('card');
}
