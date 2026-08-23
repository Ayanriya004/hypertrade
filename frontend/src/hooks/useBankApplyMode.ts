import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  fetchOnboardingInterests,
  type OnboardingInterests,
} from '../lib/onboarding';
import {
  resolveBankApplyMode,
  type BankApplyMode,
} from '../lib/bankApplyMode';
import type { UrCountry } from '../lib/urSupportedCountries';

const EMPTY_INTERESTS: OnboardingInterests = {
  bank_interest: false,
  bank_region_interest: false,
  bank_region_interest_country: null,
  card_interest: false,
};

/**
 * Region picker + Supabase waitlist flags → which CTA to show.
 *
 * Picking a supported country must not replace a general `bank_interest`
 * signup with Start KYC — that opt-in is separate from region eligibility.
 */
export function useBankApplyMode(
  selectedCountry: UrCountry | null,
  isAuthenticated: boolean,
  getAccessToken: () => Promise<string | null>,
  notListedChosen = false,
) {
  const [interests, setInterests] = useState<OnboardingInterests>(EMPTY_INTERESTS);
  const [interestsLoaded, setInterestsLoaded] = useState(!isAuthenticated);

  useEffect(() => {
    if (!isAuthenticated) {
      setInterests(EMPTY_INTERESTS);
      setInterestsLoaded(true);
      return;
    }

    let cancelled = false;
    setInterestsLoaded(false);

    void (async () => {
      const token = await getAccessToken();
      if (!token) {
        if (!cancelled) {
          setInterests(EMPTY_INTERESTS);
          setInterestsLoaded(true);
        }
        return;
      }
      const next = await fetchOnboardingInterests(token);
      if (!cancelled) {
        setInterests(next);
        setInterestsLoaded(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, getAccessToken]);

  const refreshInterests = useCallback(async () => {
    if (!isAuthenticated) return;
    const token = await getAccessToken();
    if (!token) return;
    const next = await fetchOnboardingInterests(token);
    setInterests(next);
    setInterestsLoaded(true);
  }, [isAuthenticated, getAccessToken]);

  const applyMode = useMemo((): BankApplyMode => {
    const base = resolveBankApplyMode(selectedCountry, notListedChosen);

    // Returning user already on the general waitlist (and not via a specific
    // unsupported region) — keep showing their waitlist status instead of the
    // initial "Select your region" prompt, so they see the "you're on the
    // list" confirmation.
    if (
      base === 'select_region' &&
      isAuthenticated &&
      interestsLoaded &&
      interests.bank_interest &&
      !interests.bank_region_interest
    ) {
      return 'bank_waitlist';
    }

    return base;
  }, [selectedCountry, notListedChosen, isAuthenticated, interestsLoaded, interests]);

  return { applyMode, interests, interestsLoaded, refreshInterests };
}
